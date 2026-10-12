import { createProject, setSessionPolicy, updateProject, type SessionPolicyWriteError } from "./projects";
import type { ProjectDraft, ProjectWriteError } from "../domain/projects";
import type { SessionPolicy } from "../domain/session-settings";
import { setDefinitionArchived, setRunArchived } from "./archive";
import type { DefinitionSummary } from "../projections/definition-view";
import type { CompiledWorkflow, Event as CoreEvent, Workflow, Writer } from "../core-client/core-types";
import type { CoreClient } from "../core-client/client";
import { commitEvent, type EventCommitResult, type Result } from "./commit";
import { requestDigest } from "./receipts";
import type { PinnedPrompts } from "./json-column-types";
import type { ProjectId, ProjectRecord, RunId } from "./schema-records";
import type { Result as SharedResult } from "../domain/primitives";
import { inTransaction, type TransactionalSqlExecutor } from "./sql-executor";
import { resolveWorkflowPrompts, storePromptContents, type PromptContent } from "./prompt-content";
import { writeOperatorEvent, writeRunEventFrame } from "./operator-events";
import { deleteRun as deleteStoredRun, type DeleteRunResult } from "./run-lifecycle";
import { OPERATION_REGISTRY } from "../operations/registry";

export interface CompileRequest { readonly workflow: Workflow }
export interface CompileResult { readonly program: CompiledWorkflow }
export interface StartRunRequest extends CompileRequest { readonly input: unknown; readonly request_id?: string }
export interface StartPinnedRunRequest { readonly digest: string; readonly input: unknown; readonly request_id: string }
export interface StartedRun { readonly run_id: RunId; readonly bundle_id: string }

/**
 * One domain event submitted to the authority. The writer comes from the
 * caller's verified credential, never from a request body, and ingress_id
 * makes the submission idempotent through authority.ingress_receipt.
 */
export interface EventSubmission {
  readonly run_id: RunId;
  readonly event: CoreEvent;
  readonly writer: Writer;
  readonly ingress_id: string | null;
}

export interface MutationService {
  compile(request: CompileRequest): Promise<Result<CompileResult>>;
  pinDefinition(request: CompileRequest): Promise<Result<DefinitionSummary>>;
  startRun(request: StartRunRequest): Promise<Result<StartedRun>>;
  startRunByDigest(request: StartPinnedRunRequest): Promise<Result<StartedRun>>;
  /** The sole domain-write entry: every event reaches the evaluator through here. */
  submit(input: EventSubmission): Promise<Result<EventCommitResult>>;
  /** Operator registry and visibility writes; none of them is read by evaluation. */
  createProject(id: ProjectId, draft: ProjectDraft): Promise<SharedResult<ProjectRecord, ProjectWriteError>>;
  updateProject(id: ProjectId, draft: ProjectDraft): Promise<SharedResult<ProjectRecord, ProjectWriteError>>;
  setSessionPolicy(id: ProjectId, policy: SessionPolicy): Promise<SharedResult<SessionPolicy, SessionPolicyWriteError>>;
  setRunArchived(run_id: RunId, is_archived: boolean): Promise<boolean>;
  setDefinitionArchived(bundle_id: string, is_archived: boolean): Promise<boolean>;
}

export interface ProviderCapabilityInput { readonly workflow: Workflow; readonly input: unknown }
export interface ProviderCapabilities {
  readonly probe?: (kind: string) => Promise<Result<true>>;
  readonly check_github: (input: ProviderCapabilityInput) => Promise<Result<true>>;
}

/** Code operations backed by the forge; an agent worker needs no provider. */
const GITHUB_OPERATIONS = new Set(["repository.prepare", "pull_request.observe"]);
export function requiredProviderKinds(workflow: Workflow): readonly string[] {
  for (const stage of Object.values(workflow.stages))
    for (const worker of Object.values(stage.workers))
      if (worker.kind === "code" && GITHUB_OPERATIONS.has(worker.operation)) return ["github"];
  return [];
}

function error(operation: string, entity_id: string, detail: string): Result<never> { return { ok: false, error: { operation, entity_id, detail } }; }

/** A stable id for a seed, so a replayed request_id resolves to the same run. */
function derivedId(seed: string): string {
  const hash = requestDigest({ seed });
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/** Prompt text by key, which is what the core's compile input takes. */
function promptTexts(contents: readonly PromptContent[], pinned: PinnedPrompts): Record<string, string> {
  const by_digest = new Map(contents.map((content) => [content.content_digest, content.content]));
  const texts: Record<string, string> = {};
  for (const [key, digest] of Object.entries(pinned)) {
    const content = by_digest.get(digest);
    if (content !== undefined) texts[key] = content;
  }
  return texts;
}

export async function compileWorkflow(core: CoreClient, workflow: Workflow, prompts: Record<string, string>): Promise<Result<CompileResult>> {
  const response = await core.request("compile", { workflow, operations: [...OPERATION_REGISTRY], prompts });
  if (!response.ok) return error("compile", workflow.workflow, JSON.stringify(response.error));
  if (response.value.kind !== "compiled") return error("compile", workflow.workflow, "core returned a non-compiled response");
  return { ok: true, value: { program: response.value.value } };
}

export function createMutationService(db: TransactionalSqlExecutor, core: CoreClient, provider_capabilities?: ProviderCapabilities): MutationService {
  /** Resolve prompts, compile, and store the bytes plus the pinned key -> digest map. */
  async function pin(workflow: Workflow, operation: string): Promise<Result<{ readonly bundle_id: string; readonly program: CompiledWorkflow; readonly pinned: PinnedPrompts }>> {
    const prompts = resolveWorkflowPrompts(workflow, operation);
    if (!prompts.ok) return prompts;
    const compiled = await compileWorkflow(core, workflow, promptTexts(prompts.value.contents, prompts.value.pinned));
    if (!compiled.ok) return compiled;
    const bundle_id = crypto.randomUUID();
    const stored_id = await db.transaction(async (tx) => {
      await storePromptContents(tx, prompts.value.contents);
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO authority.definition_bundle (id,digest,source,checked_program,prompts)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (digest) DO NOTHING RETURNING id`,
        [bundle_id, compiled.value.program.digest, JSON.stringify(workflow), JSON.stringify(compiled.value.program), JSON.stringify(prompts.value.pinned)]);
      if (inserted[0]) await writeOperatorEvent(tx, null, inserted[0].id, { kind: "invalidate", data: { target: "definitions", run_id: null } });
      const existing = await tx.query<{ id: string }>("SELECT id FROM authority.definition_bundle WHERE digest=$1", [compiled.value.program.digest]);
      return existing[0]?.id ?? null;
    });
    if (!stored_id) return error(operation, compiled.value.program.digest, "stored definition missing");
    return { ok: true, value: { bundle_id: stored_id, program: compiled.value.program, pinned: prompts.value.pinned } };
  }

  async function checkProviders(workflow: Workflow, input: unknown, operation: string): Promise<Result<never> | null> {
    for (const kind of requiredProviderKinds(workflow)) {
      if (kind === "github") {
        if (!provider_capabilities) return error(operation, workflow.workflow, "missing provider capability: github token");
        const capability = await provider_capabilities.check_github({ workflow, input });
        if (!capability.ok) return error(operation, workflow.workflow, `missing provider capability: github ${capability.error.detail}`);
        continue;
      }
      if (!provider_capabilities?.probe) return error(operation, workflow.workflow, `missing provider capability: ${kind} probe unavailable`);
      const capability = await provider_capabilities.probe(kind);
      if (!capability.ok) return error(operation, workflow.workflow, `missing provider capability: ${kind} ${capability.error.detail}`);
    }
    return null;
  }

  async function launch(input: unknown, request_id: string | undefined, bundle_id: string): Promise<Result<StartedRun>> {
    // A launch is an event like any other. Deriving run_id from request_id lets
    // authority.ingress_receipt dedupe a replayed launch without a second receipt table.
    const run_id = (request_id === undefined ? crypto.randomUUID() : derivedId(`launch:${request_id}`)) as RunId;
    const committed = await commitEvent(db, core, {
      run_id, ingress_id: request_id ?? null, definition_bundle_id: bundle_id,
      event: { kind: "launched", input }, writer: { kind: "engine" },
    }, async (tx, result) => {
      await writeOperatorEvent(tx, run_id, run_id, { kind: "invalidate", data: { target: "runs", run_id } });
      await writeRunEventFrame(tx, run_id, result.event_id);
    });
    if (!committed.ok) return committed;
    if (committed.value.kind === "conflict" || committed.value.kind === "rejected")
      return error("start_run", run_id, committed.value.detail);
    return { ok: true, value: { run_id, bundle_id } };
  }

  return {
    compile: async (request) => {
      const prompts = resolveWorkflowPrompts(request.workflow, "compile");
      if (!prompts.ok) return prompts;
      return compileWorkflow(core, request.workflow, promptTexts(prompts.value.contents, prompts.value.pinned));
    },
    createProject: (id, draft) => db.transaction(async (tx) => {
      const result = await createProject(tx, id, draft);
      if (result.ok) await writeOperatorEvent(tx, null, id, { kind: "invalidate", data: { target: "projects", run_id: null } });
      return result;
    }),
    updateProject: (id, draft) => db.transaction(async (tx) => {
      const result = await updateProject(tx, id, draft);
      if (result.ok) await writeOperatorEvent(tx, null, id, { kind: "invalidate", data: { target: "projects", run_id: null } });
      return result;
    }),
    setSessionPolicy: (id, policy) => db.transaction(async (tx) => {
      const result = await setSessionPolicy(inTransaction(tx), id, policy);
      if (result.ok) await writeOperatorEvent(tx, null, id, { kind: "invalidate", data: { target: "projects", run_id: null } });
      return result;
    }),
    setRunArchived: (run_id, is_archived) => db.transaction(async (tx) => {
      const changed = await setRunArchived(tx, run_id, is_archived);
      if (changed) await writeOperatorEvent(tx, run_id, run_id, { kind: "invalidate", data: { target: "run", run_id } });
      return changed;
    }),
    setDefinitionArchived: (bundle_id, is_archived) => db.transaction(async (tx) => {
      const changed = await setDefinitionArchived(tx, bundle_id, is_archived);
      if (changed) await writeOperatorEvent(tx, null, bundle_id, { kind: "invalidate", data: { target: "definitions", run_id: null } });
      return changed;
    }),
    async pinDefinition(request) {
      const capability = await checkProviders(request.workflow, null, "pin_definition");
      if (capability) return capability;
      const pinned = await pin(request.workflow, "pin_definition");
      if (!pinned.ok) return pinned;
      const rows = await db.query<DefinitionSummary>("SELECT id AS bundle_id,digest,source,archived_at FROM authority.definition_bundle WHERE id=$1", [pinned.value.bundle_id]);
      return rows[0] ? { ok: true, value: rows[0] } : error("pin_definition", pinned.value.bundle_id, "stored definition missing");
    },
    async startRunByDigest(request) {
      try {
        const rows = await db.query<{ id: string; source: Workflow }>("SELECT id,source FROM authority.definition_bundle WHERE digest=$1", [request.digest]);
        const stored = rows[0];
        if (!stored) return error("start_run_by_digest", request.digest, "definition digest not found");
        const capability = await checkProviders(stored.source, request.input, "start_run");
        if (capability) return capability;
        return await launch(request.input, request.request_id, stored.id);
      } catch (cause) { return error("start_run_storage", request.request_id, String(cause)); }
    },
    async startRun(request) {
      try {
        const capability = await checkProviders(request.workflow, request.input, "start_run");
        if (capability) return capability;
        const pinned = await pin(request.workflow, "start_run");
        if (!pinned.ok) return pinned;
        return await launch(request.input, request.request_id, pinned.value.bundle_id);
      } catch (cause) { return error("start_run_storage", request.request_id ?? "", String(cause)); }
    },
    async submit(input) {
      try {
        return await commitEvent(db, core, {
          run_id: input.run_id, ingress_id: input.ingress_id, event: input.event, writer: input.writer,
        }, async (tx, result) => { await writeRunEventFrame(tx, input.run_id, result.event_id); });
      } catch (cause) { return error("submit", input.run_id, String(cause)); }
    },
  };
}

// Run cancellation/deletion and observed results share the mutation entry.
export { cancelRun, type CancelRunCommand, type CancelRunResult } from "./run-lifecycle";
export async function deleteRun(db: TransactionalSqlExecutor, run_id: string): Promise<DeleteRunResult> {
  return db.transaction(async (tx) => {
    const result = await deleteStoredRun(inTransaction(tx), run_id);
    if (result.kind === "deleted") await writeOperatorEvent(tx, null, run_id, { kind: "invalidate", data: { target: "run", run_id: run_id as RunId } });
    return result;
  });
}
export { persistEffectResult } from "./effect-results";
/** Collaboration writes share this mutation boundary with scope decisions. */
export { addCollaborationMessage, addReviewItem, collaborationRecordId, createCollaborationThread,
  findCollaborationDelivery, readCollaborationThreads, readRevisionCollaborationTarget, recordCollaborationDelivery } from "./collaboration";
