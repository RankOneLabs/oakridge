import type { CoreResult } from "../core-client/transport-errors";
import { stagePublications } from "./stage-publications";
import { prepareChildCancellations } from "./child-cancellation";
import type { CheckedProgram, DecisionOutcome, DefinitionBundle, OperationManifest, Trigger, Output } from "../core-client/generated-contracts";
import type { CoreClient } from "../core-client/client";
import { commitDecision, type CommitRequest, type CommitResult, type OutputPublication, type Result } from "./commit";
import { requestDigest, findReceipt, type IngressIdentity } from "./receipts";
import { readSnapshot, type AuthoritySnapshot } from "./snapshot-reader";
import type { RunId, ScopeId } from "./schema-records";
import type { TransactionalSqlExecutor } from "./sql-executor";

export interface CompileRequest { readonly bundle: DefinitionBundle; readonly available_operations: readonly OperationManifest[] }
export interface CompileResult { readonly program: CheckedProgram }
export interface StartRunRequest extends CompileRequest { readonly input: unknown }
export interface EvaluationInput { readonly source: AuthoritySnapshot; readonly bundle: DefinitionBundle; readonly available_operations: readonly OperationManifest[] }
export interface EvaluationResult { readonly decision: DecisionOutcome }
export interface Decision { readonly source: AuthoritySnapshot; readonly outcome: DecisionOutcome }
export interface PreparedDecision { readonly request_digest: string; readonly decision: Decision }
export interface MutationInput { readonly request_digest?: string; readonly execution_authority?: string; readonly run_id: RunId; readonly scope_id: ScopeId; readonly ingress_id: string; readonly trigger: Trigger; readonly operator_version: number | null; readonly outputs?: readonly OutputPublication[]; readonly prepared?: PreparedDecision }
export interface StartedRun { readonly run_id: RunId; readonly root_scope_id: ScopeId; readonly bundle_id: string }
export interface MutationService { compile(request: CompileRequest): Promise<Result<CompileResult>>; startRun(request: StartRunRequest): Promise<Result<StartedRun>>; decide(input: MutationInput): Promise<Result<CommitResult>> }

export function selectMutationIdentity(input: MutationInput): IngressIdentity {
  return { run_id: input.run_id, scope_id: input.scope_id, ingress_id: input.ingress_id, request_digest: input.prepared?.request_digest ?? input.request_digest ?? requestDigest({ trigger: input.trigger, outputs: input.outputs ?? [], operator_version: input.operator_version }) };
}

function error(operation: string, entity_id: string, detail: string): Result<never> { return { ok: false, error: { operation, entity_id, detail } }; }
export async function compileBundle(core: CoreClient, request: CompileRequest): Promise<Result<CompileResult>> {
  const response = await core.request("compile", { bundle: request.bundle, available_operations: [...request.available_operations] });
  if (!response.ok) return error("compile", request.bundle.key, JSON.stringify(response.error));
  if (response.value.kind !== "compiled") return error("compile", request.bundle.key, "core returned a non-compiled response");
  return { ok: true, value: { program: response.value.value } };
}
/** The sole evaluator call; callers retain the core transport/domain error distinction. */
export function requestEvaluation(core: CoreClient, input: EvaluationInput): Promise<CoreResult<Output>> {
  return core.request("evaluate", { bundle: input.bundle, available_operations: [...input.available_operations], snapshot: input.source.snapshot });
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
  return { ok: true, value: { identity: selectMutationIdentity(input),
    execution_authority: input.execution_authority, read_set: decision.source.read_set, decision: decision.outcome, outputs: input.outputs ?? [], capacity, effects, operator_version: input.operator_version } };
}
export function createMutationService(db: TransactionalSqlExecutor, core: CoreClient): MutationService {
  return {
    compile: (request) => compileBundle(core, request),
    async startRun(request) {
      const compiled = await compileBundle(core, request);
      if (!compiled.ok) return compiled;
      const root = compiled.value.program.scopes.find((scope) => scope.key === request.bundle.root);
      if (!root) return error("start_run", request.bundle.key, "compiled root scope missing");
      const root_definition = request.bundle.scopes.find((scope) => scope.key === request.bundle.root);
      if (!root_definition) return error("start_run", request.bundle.key, "root definition missing");
      const validated = await core.request("validate_payload", { bundle: request.bundle, available_operations: [...request.available_operations], schema: root_definition.input_schema, payload: request.input });
      if (!validated.ok) return error("start_run", request.bundle.key, JSON.stringify(validated.error));
      if (validated.value.kind !== "validated") return error("start_run", request.bundle.key, "core returned a non-validated input");
      const run_id = crypto.randomUUID() as RunId;
      const root_scope_id = crypto.randomUUID() as ScopeId;
      const bundle_id = crypto.randomUUID();
      let actual_bundle_id: string = bundle_id;
      try {
        await db.transaction(async (tx) => {
          await tx.query("INSERT INTO authority.definition_bundle (id,digest,source,checked_program) VALUES ($1,$2,$3,$4) ON CONFLICT (digest) DO NOTHING", [bundle_id, compiled.value.program.digest, JSON.stringify(request.bundle), JSON.stringify(compiled.value.program)]);
          const stored = await tx.query<{ id: string }>("SELECT id FROM authority.definition_bundle WHERE digest=$1", [compiled.value.program.digest]);
          actual_bundle_id = stored[0]!.id;
          await tx.query("INSERT INTO authority.run (id,definition_bundle_id) VALUES ($1,$2)", [run_id, actual_bundle_id]);
          await tx.query("INSERT INTO authority.scope_instance (id,run_id,scope_key,input,local_state) VALUES ($1,$2,$3,$4,$5)", [root_scope_id, run_id, request.bundle.root, JSON.stringify(validated.value.value), JSON.stringify(root.initial)]);
          const pools = new Map<string, number>();
          for (const scope of request.bundle.scopes) for (const pool of scope.pools) {
            const previous = pools.get(pool.key);
            if (previous !== undefined && previous !== pool.limit) throw new Error(`capacity pool ${pool.key} has conflicting limits`);
            pools.set(pool.key, pool.limit);
          }
          for (const [pool_key, capacity] of pools) await tx.query("INSERT INTO authority.capacity_pool (id,run_id,pool_key,capacity) VALUES ($1,$2,$3,$4)", [crypto.randomUUID(), run_id, pool_key, capacity]);
        });
        return { ok: true, value: { run_id, root_scope_id, bundle_id: actual_bundle_id } };
      } catch (cause) { return error("start_run", run_id, String(cause)); }
    },
    async decide(input) {
      const identity = selectMutationIdentity(input);
      try {
        const prior = await findReceipt(db, identity);
        if (prior.kind === "replay") return { ok: true, value: { kind: "Replayed", receipt: prior.receipt } };
        if (prior.kind === "conflict") return { ok: true, value: { kind: "Conflict", detail: "ingress identity reused with different request content" } };
        for (let attempt = 0; attempt < 3; attempt++) {
          const source = input.prepared?.decision.source ?? await readSnapshot(db, input.scope_id, input.trigger);
          if (!source || source.owner.run_id !== input.run_id) return error("decide", input.scope_id, "scope not found in run");
          if (input.operator_version !== null && input.operator_version !== source.owner.version) return { ok: true, value: { kind: "Conflict", detail: "operator target changed; refresh decision" } };
          if (source.owner.is_terminal) return { ok: true, value: { kind: "Rejected", detail: "owner is terminal" } };
          const bundles = await db.query<{ source: DefinitionBundle }>("SELECT b.source FROM authority.definition_bundle b JOIN authority.run r ON r.definition_bundle_id=b.id WHERE r.id=$1", [input.run_id]);
          const bundle = bundles[0]?.source;
          if (!bundle) return error("decide", input.run_id, "definition bundle missing");
          const staged = input.outputs?.some((output) => output.revision_id) ? stagePublications(bundle, source, input.outputs) : { ok: true as const, value: source };
          if (!staged.ok) return staged;
          const evaluated: Result<EvaluationResult> = input.prepared
            ? { ok: true, value: { decision: input.prepared.decision.outcome } }
            : await evaluateSnapshot(core, { source: staged.value, bundle, available_operations: bundle.operations });
          if (!evaluated.ok) return evaluated;
          const request = prepareCommit(input, { source, outcome: evaluated.value.decision });
          if (!request.ok) return request;
          const children = await prepareChildCancellations(db, core, bundle, input, { source, outcome: evaluated.value.decision });
          if (!children.ok) return children;
          const committed = await commitDecision(db, { ...request.value, child_cancellations: children.value }, source);
          if (!committed.ok || committed.value.kind !== "Conflict" || input.operator_version !== null) return committed;
        }
        return { ok: true, value: { kind: "Conflict", detail: "read set changed repeatedly; refresh decision" } };
      } catch (cause) { return error("decide", input.scope_id, String(cause)); }
    },
  };
}

// Run cancellation/deletion and observed results share the mutation entry.
export { cancelRun, deleteRun, type ScopeCancellationPayload } from "./run-lifecycle";
export { persistEffectResult } from "./effect-results";
