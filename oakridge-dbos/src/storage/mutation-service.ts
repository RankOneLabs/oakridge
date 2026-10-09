import { findLaunchReceipt, type LaunchReceiptLookup } from "./launch-receipts";
import type { DefinitionSummary } from "../projections/definition-view";
import type { CoreResult } from "../core-client/transport-errors";
import { stagePublications } from "./stage-publications";
import { currentTargetRevisions, targetsMatch, type TargetRevision } from "./command-selection";
import { prepareChildCancellations } from "./child-cancellation";
import { CORE_MAX_FRAME_BYTES, type CompiledBundle, type DecisionOutcome, type DefinitionBundle, type Trigger, type Output } from "../core-client/generated-contracts";
import type { CoreClient } from "../core-client/client";
import { commitDecision, replayResult, type CommitRequest, type CommitResult, type OutputPublication, type Result } from "./commit";
import { requestDigest, findReceipt, type IngressIdentity } from "./receipts";
import { readSnapshot, type AuthoritySnapshot } from "./snapshot-reader";
import type { RunId, ScopeId } from "./schema-records";
import type { SqlExecutor, TransactionalSqlExecutor } from "./sql-executor";
import { resolveBundlePrompts, storePromptContents, type PromptContent } from "./prompt-content";

export interface CompileRequest { readonly bundle: DefinitionBundle }
export interface CompileResult { readonly program: CompiledBundle }
export interface StartRunRequest extends CompileRequest { readonly input: unknown; readonly request_id?: string }
export interface StartPinnedRunRequest { readonly digest: string; readonly input: unknown; readonly request_id: string }
export interface EvaluationInput { readonly source: AuthoritySnapshot; readonly bundle: DefinitionBundle }
export interface EvaluationResult { readonly decision: DecisionOutcome }
export interface Decision { readonly source: AuthoritySnapshot; readonly outcome: DecisionOutcome }
export interface PreparedDecision { readonly request_digest: string; readonly decision: Decision; readonly target_revisions?: readonly TargetRevision[] }
export interface MutationInput { readonly request_digest?: string; readonly execution_authority?: string; readonly run_id: RunId; readonly scope_id: ScopeId; readonly ingress_id: string; readonly trigger: Trigger; readonly operator_version: number | null; readonly outputs?: readonly OutputPublication[]; readonly prepared?: PreparedDecision }
export interface StartedRun { readonly run_id: RunId; readonly root_scope_id: ScopeId; readonly bundle_id: string }
export interface MutationService { compile(request: CompileRequest): Promise<Result<CompileResult>>; pinDefinition(request: CompileRequest): Promise<Result<DefinitionSummary>>; startRun(request: StartRunRequest): Promise<Result<StartedRun>>; startRunByDigest(request: StartPinnedRunRequest): Promise<Result<StartedRun>>; decide(input: MutationInput): Promise<Result<CommitResult>> }
export interface ProviderCapabilityInput { readonly bundle: DefinitionBundle; readonly input: unknown }
export interface ProviderCapabilities {
  readonly probe?: (kind: string) => Promise<Result<true>>;
  readonly check_github: (input: ProviderCapabilityInput) => Promise<Result<true>>;
}
export function requiredProviderKinds(bundle: DefinitionBundle): readonly string[] {
  return [...new Set(bundle.operations.map((manifest) => manifest.provider_kind))];
}

export function selectMutationIdentity(input: MutationInput): IngressIdentity {
  return { run_id: input.run_id, scope_id: input.scope_id, ingress_id: input.ingress_id, request_digest: input.prepared?.request_digest ?? input.request_digest ?? requestDigest({ trigger: input.trigger, outputs: input.outputs ?? [], operator_version: input.operator_version }) };
}

function error(operation: string, entity_id: string, detail: string): Result<never> { return { ok: false, error: { operation, entity_id, detail } }; }
async function bundlePrompts(db: SqlExecutor, bundle: DefinitionBundle, operation: string): Promise<Result<readonly PromptContent[]>> {
  try { return await resolveBundlePrompts(db, bundle, operation); }
  catch (cause) { return error(operation, bundle.key, String(cause)); }
}
function launchReplay(prior: LaunchReceiptLookup, request_id: string): Result<StartedRun> | null {
  if (prior.kind === "new") return null;
  if (prior.kind === "replay") return { ok: true, value: prior.run };
  return error(prior.kind === "gone" ? "launch_gone" : "launch_conflict", request_id,
    prior.kind === "gone" ? "the launched run was deleted" : "request ID reused with different launch content");
}
export async function compileBundle(core: CoreClient, request: CompileRequest): Promise<Result<CompileResult>> {
  if (Buffer.byteLength(JSON.stringify(request.bundle)) > CORE_MAX_FRAME_BYTES) return error("compile", request.bundle.key, `oversized_payload: definition bundle exceeds ${CORE_MAX_FRAME_BYTES} bytes`);
  const response = await core.request("compile", { bundle: request.bundle });
  if (!response.ok) return error("compile", request.bundle.key, JSON.stringify(response.error));
  if (response.value.kind !== "compiled") return error("compile", request.bundle.key, "core returned a non-compiled response");
  return { ok: true, value: { program: response.value.value } };
}
/** Whether every published output still matches its declared schema. */
export type PublicationCheck = { readonly kind: "valid" } | { readonly kind: "mismatch"; readonly output_key: string };
/**
 * Published outputs arrive as checked values from outside the core, so the
 * core rechecks each against the schema its scope declares. Undeclared
 * outputs are left to the commit's declaration check.
 */
export async function checkPublications(core: CoreClient, bundle: DefinitionBundle, scope_key: string, outputs: readonly OutputPublication[]): Promise<Result<PublicationCheck>> {
  const scope = bundle.scopes.find((item) => item.key === scope_key);
  for (const output of outputs) {
    const declared = scope?.outputs.find((item) => item.key === output.output_key);
    if (!declared) continue;
    const checked = await core.request("validate_value", { bundle, schema: declared.schema, value: output.body });
    if (checked.ok) continue;
    if (checked.error.kind === "transport") return error("validate_publication", output.output_key, checked.error.detail.detail);
    return { ok: true, value: { kind: "mismatch", output_key: output.output_key } };
  }
  return { ok: true, value: { kind: "valid" } };
}
/** The sole evaluator call; callers retain the core transport/domain error distinction. */
export function requestEvaluation(core: CoreClient, input: EvaluationInput): Promise<CoreResult<Output>> {
  return core.request("evaluate", { bundle: input.bundle, snapshot: input.source.snapshot });
}
export async function evaluateSnapshot(core: CoreClient, input: EvaluationInput): Promise<Result<EvaluationResult>> {
  const response = await requestEvaluation(core, input);
  if (!response.ok) return error("evaluate", input.source.owner.id, JSON.stringify(response.error));
  if (response.value.kind !== "evaluated") return error("evaluate", input.source.owner.id, "core returned a non-evaluated response");
  return { ok: true, value: { decision: response.value.value } };
}
export function prepareCommit(input: MutationInput, decision: Decision): Result<CommitRequest> {
  const capacity = decision.outcome.kind === "apply" ? decision.outcome.mutations.flatMap((mutation) => {
    if (mutation.kind !== "acquire" && mutation.kind !== "release") return [];
    const pool = decision.source.pools.find((item) => item.pool_key === mutation.pool);
    return pool ? [{ kind: mutation.kind, pool_id: pool.id, scope_id: input.scope_id }] : [];
  }) : [];
  const effects = decision.outcome.kind === "apply" ? decision.outcome.invocations.map((invocation, index) => ({ effect_key: `${input.ingress_id}:${index}`, payload: invocation.input, execution_id: null })) : [];
  if (decision.outcome.kind === "apply" && capacity.length !== decision.outcome.mutations.filter((mutation) => mutation.kind === "acquire" || mutation.kind === "release").length) return error("prepare_commit", input.scope_id, "capacity pool missing");
  // A reject writes nothing but its receipt, so a staged publication's output must not ride along.
  const outputs = decision.outcome.kind === "reject" ? [] : (input.outputs ?? []);
  return { ok: true, value: { identity: selectMutationIdentity(input),
    execution_authority: input.execution_authority, read_set: decision.source.read_set, decision: decision.outcome, outputs, capacity, effects, operator_version: input.operator_version } };
}
export function createMutationService(db: TransactionalSqlExecutor, core: CoreClient, provider_capabilities?: ProviderCapabilities): MutationService {
  return {
    compile: (request) => compileBundle(core, request),
    async pinDefinition(request) {
      const prompts = await bundlePrompts(db, request.bundle, "pin_definition");
      if (!prompts.ok) return prompts;
      const compiled = await compileBundle(core, request);
      if (!compiled.ok) return compiled;
      // Pin-time liveness probes cover every declared kind. The run-time GitHub
      // check below is deliberately duplicated to verify access to selected repositories.
      for (const kind of requiredProviderKinds(request.bundle)) {
        if (!provider_capabilities?.probe) return error("pin_definition", request.bundle.key, `missing provider capability: ${kind} probe unavailable`);
        const capability = await provider_capabilities.probe(kind);
        if (!capability.ok) return error("pin_definition", request.bundle.key, `missing provider capability: ${kind} ${capability.error.detail}`);
      }
      try {
        const bundle_id = crypto.randomUUID();
        const rows = await db.transaction(async (tx) => {
          await storePromptContents(tx, prompts.value);
          await tx.query("INSERT INTO authority.definition_bundle (id,digest,source,checked_program) VALUES ($1,$2,$3,$4) ON CONFLICT (digest) DO NOTHING",
            [bundle_id, compiled.value.program.digest, JSON.stringify(request.bundle), JSON.stringify(compiled.value.program)]);
          return tx.query<DefinitionSummary>("SELECT id AS bundle_id,digest,source FROM authority.definition_bundle WHERE digest=$1", [compiled.value.program.digest]);
        });
        if (!rows[0]) return error("pin_definition", compiled.value.program.digest, "stored definition missing");
        return { ok: true, value: rows[0] };
      } catch (cause) { return error("pin_definition", request.bundle.key, String(cause)); }
    },
    async startRunByDigest(request) {
      try {
        const prior = launchReplay(await findLaunchReceipt(db, request.request_id, requestDigest({ digest: request.digest, input: request.input })), request.request_id);
        if (prior) return prior;
        const rows = await db.query<{ source: DefinitionBundle }>("SELECT source FROM authority.definition_bundle WHERE digest=$1", [request.digest]);
        if (!rows[0]) return error("start_run_by_digest", request.digest, "definition digest not found");
        return this.startRun({ bundle: rows[0].source, input: request.input, request_id: request.request_id });
      } catch (cause) { return error("start_run_storage", request.request_id, String(cause)); }
    },
    async startRun(request) {
      const prompts = await bundlePrompts(db, request.bundle, "start_run");
      if (!prompts.ok) return prompts;
      const compiled = await compileBundle(core, request);
      if (!compiled.ok) return compiled;
      if (requiredProviderKinds(request.bundle).includes("github")) {
        if (!provider_capabilities) return error("start_run", request.bundle.key, "missing provider capability: github token");
        const capability = await provider_capabilities.check_github(request);
        if (!capability.ok) return error("start_run", request.bundle.key, `missing provider capability: github ${capability.error.detail}`);
      }
      const root = compiled.value.program.scopes.find((scope) => scope.key === request.bundle.root);
      if (!root) return error("start_run", request.bundle.key, "compiled root scope missing");
      const root_definition = request.bundle.scopes.find((scope) => scope.key === request.bundle.root);
      if (!root_definition) return error("start_run", request.bundle.key, "root definition missing");
      const validated = await core.request("validate_payload", { bundle: request.bundle, schema: root_definition.input_schema, payload: request.input });
      if (!validated.ok) return error("start_run", request.bundle.key, JSON.stringify(validated.error));
      if (validated.value.kind !== "validated") return error("start_run", request.bundle.key, "core returned a non-validated input");
      const run_id = crypto.randomUUID() as RunId;
      const root_scope_id = crypto.randomUUID() as ScopeId;
      const bundle_id = crypto.randomUUID();
      const request_digest = requestDigest({ digest: compiled.value.program.digest, input: request.input });
      try {
        return await db.transaction(async (tx): Promise<Result<StartedRun>> => {
          if (request.request_id !== undefined) {
            // Serialize competing launches before reading their receipt. Read committed
            // lets a waiter see the preceding transaction's committed result.
            await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`launch:${request.request_id}`]);
            const prior = launchReplay(await findLaunchReceipt(tx, request.request_id, request_digest), request.request_id);
            if (prior) return prior;
          }
          await storePromptContents(tx, prompts.value);
          await tx.query("INSERT INTO authority.definition_bundle (id,digest,source,checked_program) VALUES ($1,$2,$3,$4) ON CONFLICT (digest) DO NOTHING", [bundle_id, compiled.value.program.digest, JSON.stringify(request.bundle), JSON.stringify(compiled.value.program)]);
          const stored = await tx.query<{ id: string }>("SELECT id FROM authority.definition_bundle WHERE digest=$1", [compiled.value.program.digest]);
          const actual_bundle_id = stored[0]!.id;
          await tx.query("INSERT INTO authority.run (id,definition_bundle_id) VALUES ($1,$2)", [run_id, actual_bundle_id]);
          await tx.query("INSERT INTO authority.scope_instance (id,run_id,scope_key,input,local_state) VALUES ($1,$2,$3,$4,$5)", [root_scope_id, run_id, request.bundle.root, JSON.stringify(validated.value.value), JSON.stringify(root.initial)]);
          const pools = new Map<string, number>();
          for (const scope of request.bundle.scopes) for (const pool of scope.pools) {
            const previous = pools.get(pool.key);
            if (previous !== undefined && previous !== pool.limit) throw new Error(`capacity pool ${pool.key} has conflicting limits`);
            pools.set(pool.key, pool.limit);
          }
          for (const [pool_key, capacity] of pools) await tx.query("INSERT INTO authority.capacity_pool (id,run_id,pool_key,capacity) VALUES ($1,$2,$3,$4)", [crypto.randomUUID(), run_id, pool_key, capacity]);
          const run: StartedRun = { run_id, root_scope_id, bundle_id: actual_bundle_id };
          if (request.request_id !== undefined) await tx.query(
            "INSERT INTO authority.launch_receipt (request_id,request_digest,run_id,root_scope_id,bundle_id) VALUES ($1,$2,$3,$4,$5)",
            [request.request_id, request_digest, run_id, root_scope_id, actual_bundle_id]);
          return { ok: true, value: run };
        });
      } catch (cause) { return error("start_run_storage", run_id, String(cause)); }
    },
    async decide(input) {
      const identity = selectMutationIdentity(input);
      const staged_input: MutationInput = { ...input, request_digest: identity.request_digest,
        outputs: (input.outputs ?? []).map((output) => ({ ...output, revision_id: output.revision_id ?? crypto.randomUUID() })) };
      try {
        const prior = await findReceipt(db, identity);
        if (prior.kind === "replay") return { ok: true, value: replayResult(prior.receipt) };
        if (prior.kind === "conflict") return { ok: true, value: { kind: "Conflict", detail: "ingress identity reused with different request content" } };
        for (let attempt = 0; attempt < 3; attempt++) {
          // Prepared sources are valid only for the first attempt. A conflict must
          // rebuild both the snapshot and its decision against fresh witnesses.
          const prepared_source = attempt === 0 ? input.prepared?.decision.source : undefined;
          const reconstruction_started = performance.now();
          const source = prepared_source ?? await readSnapshot(db, input.scope_id, input.trigger);
          console.info(JSON.stringify({ event: "snapshot_reconstruction", scope_id: input.scope_id, attempt,
            duration_ms: Number((performance.now() - reconstruction_started).toFixed(3)),
            reused_prepared: prepared_source !== undefined, read_roots: source?.reads.length ?? 0,
            observations: source?.snapshot.observations.length ?? 0, witness_rows: source?.read_set.rows.length ?? 0 }));
          if (!source || source.owner.run_id !== input.run_id) return error("decide", input.scope_id, "scope not found in run");
          if (input.operator_version !== null && input.operator_version !== source.owner.version) return { ok: true, value: { kind: "Conflict", detail: "operator target changed; refresh decision" } };
          if (source.owner.is_terminal) return { ok: true, value: { kind: "Rejected", reason: "owner_terminal", detail: "owner is terminal" } };
          const bundles = await db.query<{ source: DefinitionBundle }>("SELECT b.source FROM authority.definition_bundle b JOIN authority.run r ON r.definition_bundle_id=b.id WHERE r.id=$1", [input.run_id]);
          const bundle = bundles[0]?.source;
          if (!bundle) return error("decide", input.run_id, "definition bundle missing");
          if (attempt === 0) {
            const publications = await checkPublications(core, bundle, source.owner.scope_key, staged_input.outputs ?? []);
            if (!publications.ok) return publications;
            if (publications.value.kind === "mismatch") return { ok: true, value: { kind: "Rejected", reason: "invalid", detail: "output schema mismatch" } };
          }
          const staged = stagePublications(bundle, source, staged_input.outputs ?? []);
          if (!staged.ok) return staged;
          const evaluated: Result<EvaluationResult> = attempt === 0 && input.prepared
            ? { ok: true, value: { decision: input.prepared.decision.outcome } }
            : await evaluateSnapshot(core, { source: staged.value, bundle });
          if (!evaluated.ok) return evaluated;
          if (attempt > 0 && input.prepared?.target_revisions) {
            const command = bundle.scopes.find((item) => item.key === source.owner.scope_key)?.commands.find((item) => item.key === input.trigger.key);
            if (!command) return { ok: true, value: { kind: "Conflict", detail: "command changed during retry" } };
            // A command without targets has nothing to re-pin (and its outcome need not be an apply), as on the HTTP path.
            if (command.targets.length) {
              const revisions = await currentTargetRevisions(db, input.scope_id, command, source.snapshot.observations);
              if (!targetsMatch(command, evaluated.value.decision, input.prepared.target_revisions, revisions))
                return { ok: true, value: { kind: "Conflict", detail: "target revisions changed during retry" } };
            }
          }
          const request = prepareCommit(staged_input, { source, outcome: evaluated.value.decision });
          if (!request.ok) return request;
          const children = await prepareChildCancellations(db, core, bundle, input, { source, outcome: evaluated.value.decision });
          if (!children.ok) return children;
          const committed = await commitDecision(db, { ...request.value, child_cancellations: children.value }, source);
          if (!committed.ok || committed.value.kind !== "Conflict") return committed;
        }
        return { ok: true, value: { kind: "Conflict", detail: "read set changed repeatedly; refresh decision" } };
      } catch (cause) { return error("decide", input.scope_id, String(cause)); }
    },
  };
}

// Run cancellation/deletion and observed results share the mutation entry.
export { cancelRun, deleteRun, type ScopeCancellationPayload } from "./run-lifecycle";
export { persistEffectResult } from "./effect-results";
