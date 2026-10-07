import { PROVIDER_CATALOG, PROVIDER_ERROR_CODES, INPUT_CONTRACTS } from "../provider-catalog";
import type { CheckedValue, DefinitionBundle, ScopeDefinition, Trigger } from "../../core-client/generated-contracts";
import type { CoreClient } from "../../core-client/client";
import type { ExecutionId, JsonValue } from "../../domain/primitives";
import type { SqlExecutor } from "../../storage/sql-executor";
import { KbblExecutorAdapter } from "../../adapters/kbbl";
import { BunGitCommandRunner } from "../../runtime/git-command-runner";
import { GithubPullRequestReader, type PullRequestReader } from "../../runtime/github-pull-requests";
import { RepositoryPreparationOperation } from "./repository-preparation";
import { PullRequestObservationOperation } from "./pull-request-observation";
import { settingForRole } from "./selected-publication-contract";
import type { EffectProvider, ExternalHandle, ProviderResult, StableInvocation, TerminalObservation, ProviderCallOptions } from "../provider";
import type { Result } from "../../storage/commit";

export interface ProductionProviderOptions {
  readonly git?: import("../../domain/repository-provisioning").GitCommandRunner;
  readonly db: SqlExecutor;
  readonly core: CoreClient;
  readonly kbbl_base_url: string;
  readonly pull_requests?: PullRequestReader;
}
interface InvocationContext { readonly bundle: DefinitionBundle; readonly scope: ScopeDefinition; readonly scope_id: string; readonly run_id: string }
interface ContextRow { readonly source: DefinitionBundle; readonly scope_key: string; readonly scope_id: string; readonly run_id: string }

async function readInvocationContext(db: SqlExecutor, invocation: StableInvocation): Promise<InvocationContext | null> {
  const rows = await db.query<ContextRow>("SELECT b.source,s.scope_key,s.id AS scope_id,s.run_id FROM authority.execution e JOIN authority.scope_instance s ON s.id=e.scope_id JOIN authority.run r ON r.id=s.run_id JOIN authority.definition_bundle b ON b.id=r.definition_bundle_id WHERE e.id=$1", [invocation.execution_id]);
  const row = rows[0];
  const scope = row?.source.scopes.find((scope) => scope.key === row.scope_key);
  return row && scope ? { bundle: row.source, scope, scope_id: row.scope_id, run_id: row.run_id } : null;
}

interface ActiveFiniteCall { readonly controller: AbortController; readonly finished: Promise<void> }
function pinnedInput(invocation: StableInvocation): Result<JsonValue> {
  try { return { ok: true, value: JSON.parse(invocation.bytes) as JsonValue }; }
  catch (error) { return { ok: false, error: { operation: "decode_provider_request", entity_id: invocation.id, detail: String(error) } }; }
}
const isRecord = (value: JsonValue): value is { [key: string]: JsonValue } => !!value && typeof value === "object" && !Array.isArray(value);
const rejected = (detail: string): ProviderResult<never> => ({ kind: "permanently_rejected", code: PROVIDER_ERROR_CODES.invalid_invocation, detail });

function declaredRecovery(context: InvocationContext, invocation: StableInvocation, code: string): { readonly fact: string } | null {
  const operation = context.bundle.operations.find((item) => item.key === invocation.selection.definition.operation
    && item.version === invocation.selection.definition.contract_version);
  return operation?.recovery?.find((mapping) => mapping.code === code) ?? null;
}

export function visibleProviderCode(operation_key: string, version: number, code: string, detail: string): Extract<ProviderResult<never>, { readonly kind: "permanently_rejected" }> {
  const operation = PROVIDER_CATALOG.operations.find((item) => item.key === operation_key && item.version === version);
  return operation?.emitted_codes.some((emitted) => emitted === code)
    ? { kind: "permanently_rejected", code, detail }
    : { kind: "permanently_rejected", code: PROVIDER_ERROR_CODES.undeclared_provider_code, detail: `provider returned undeclared code ${code}: ${detail}` };
}

interface SessionFailureInput {
  readonly db: SqlExecutor;
  readonly core: CoreClient;
  readonly invocation: StableInvocation;
  readonly detail: string;
}
interface ConfiguredFailureInput extends SessionFailureInput { readonly code: string }
/** Runtime-synthesized failures traverse the same compile-verified mapping as provider failures. */
export async function recoverConfiguredFailure({ db, core, invocation, code, detail }: ConfiguredFailureInput): Promise<ProviderResult<never>> {
  const failure = visibleProviderCode(invocation.selection.definition.operation, invocation.selection.definition.contract_version, code, detail);
  const context = await readInvocationContext(db, invocation);
  if (!context || failure.code !== code) return failure;
  const mapping = declaredRecovery(context, invocation, code);
  const fact = context.scope.facts.find((item) => item.key === mapping?.fact);
  if (!fact) return failure;
  const checked = await core.request("validate_payload", { bundle: context.bundle, schema: fact.payload_schema, payload: detail });
  if (!checked.ok) return checked.error.kind === "domain" ? rejected(JSON.stringify(checked.error))
    : { kind: "transiently_unavailable", detail: JSON.stringify(checked.error) };
  if (checked.value.kind !== "validated") return rejected("core returned a non-validated recovery payload");
  return { ...failure, evidence: { id: `${invocation.id}:error`, key: fact.key, payload: checked.value.value } };
}
export async function recoverStartFailure(input: ConfiguredFailureInput): Promise<ProviderResult<never>> {
  const primary = await recoverConfiguredFailure(input);
  if (primary.kind !== "permanently_rejected" || primary.evidence) return primary;
  return recoverConfiguredFailure({ ...input, code: PROVIDER_ERROR_CODES.start_rejected,
    detail: `${input.code}: ${input.detail}` });
}
/** Host-side observation failures use the same declared recovery fact as failed sessions. */
export function recoverSessionFailure(input: SessionFailureInput): Promise<ProviderResult<never>> {
  return recoverConfiguredFailure({ ...input, code: PROVIDER_ERROR_CODES.session_failed });
}

export function createEffectProvider(options: ProductionProviderOptions): EffectProvider {
  const active_finite_calls = new Map<string, Set<ActiveFiniteCall>>();
  const repository = new RepositoryPreparationOperation(options.git ?? new BunGitCommandRunner());
  const discovery = new PullRequestObservationOperation(options.pull_requests ?? new GithubPullRequestReader({ token: process.env.OAKRIDGE_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? "" }));
  function kbbl(call: ProviderCallOptions): KbblExecutorAdapter {
    return new KbblExecutorAdapter({ base_url: options.kbbl_base_url, executor_function_identity: "selected-v1",
      fetch: (input, init) => fetch(input, { ...init, signal: call.signal }) });
  }
  async function trackFinite(invocation: StableInvocation, call: ProviderCallOptions): Promise<ProviderResult<ExternalHandle>> {
    const controller = new AbortController();
    const signal = call.signal ? AbortSignal.any([call.signal, controller.signal]) : controller.signal;
    let finish: () => void = () => {};
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const active = { controller, finished };
    const calls = active_finite_calls.get(invocation.id) ?? new Set<ActiveFiniteCall>();
    active_finite_calls.set(invocation.id, calls);
    calls.add(active);
    try { return await startInvocation(invocation, { signal }); }
    finally { calls.delete(active); if (!calls.size) active_finite_calls.delete(invocation.id); finish(); }
  }
  async function context(invocation: StableInvocation): Promise<InvocationContext | null> {
    return readInvocationContext(options.db, invocation);
  }
  async function validate(context: InvocationContext, schema: string, payload: unknown): Promise<ProviderResult<CheckedValue>> {
    const result = await options.core.request("validate_payload", { bundle: context.bundle, schema, payload });
    if (!result.ok) return result.error.kind === "domain" ? rejected(JSON.stringify(result.error)) : { kind: "transiently_unavailable", detail: JSON.stringify(result.error) };
    return result.value.kind === "validated" ? { kind: "acknowledged", value: result.value.value } : rejected("core returned a non-validated operation result");
  }
  async function recovery(context: InvocationContext, result: ProviderResult<unknown>, invocation: StableInvocation): Promise<ProviderResult<never>> {
    if (result.kind !== "permanently_rejected") return rejected("expected a permanent rejection");
    const visible = visibleProviderCode(invocation.selection.definition.operation, invocation.selection.definition.contract_version, result.code, result.detail);
    if (visible.code !== result.code) return visible;
    const mapping = declaredRecovery(context, invocation, result.code);
    const definition = context.scope.facts.find((fact) => fact.key === mapping?.fact);
    if (!definition) return result;
    const checked = await validate(context, definition.payload_schema, result.detail);
    if (checked.kind !== "acknowledged") return checked;
    const evidence: Trigger = { id: `${invocation.id}:error`, key: definition.key, payload: checked.value };
    return { ...result, evidence };
  }
  async function completed(context: InvocationContext, invocation: StableInvocation, result: unknown): Promise<ProviderResult<ExternalHandle>> {
    const worker = context.scope.workers.find((worker) => worker.key === invocation.selection.selection.worker);
    if (!worker) return rejected("selected worker is not declared");
    const checked = await validate(context, worker.result_schema, result);
    if (checked.kind !== "acknowledged") return checked;
    const fact_key = settingForRole(invocation.selection.definition.settings, "result_fact");
    const fact = fact_key ? context.scope.facts.find((fact) => fact.key === fact_key && fact.payload_schema === worker.result_schema) : null;
    if (fact_key && !fact) return rejected("result_fact must name a declared fact with the worker result schema");
    return { kind: "acknowledged", value: { kind: "completed", result: checked.value,
      ...(fact ? { evidence: { id: `${invocation.id}:result`, key: fact.key, payload: checked.value } } : {}) } };
  }
  async function startInvocation(invocation: StableInvocation, call: ProviderCallOptions): Promise<ProviderResult<ExternalHandle>> {

      const found = await context(invocation);
      if (!found) return rejected("execution context missing");
      if (call.signal?.aborted) return { kind: "uncertain", detail: "provider operation aborted before IO" };
      if (!invocation.request || invocation.request.version !== 1) return rejected("selected provider request is missing or unsupported");
      const contract = invocation.selection.definition;
      if (contract.contract_version !== 1) return rejected("unsupported operation contract version");
      if (invocation.request.kind === INPUT_CONTRACTS.session) {
        const result = await kbbl(call).start_pinned({ session_key: invocation.request.session_key, body: invocation.bytes });
        return result.kind === "acknowledged" && result.value.kind === INPUT_CONTRACTS.session ? { kind: "acknowledged", value: result.value }
          : result.kind === "acknowledged" ? rejected("kbbl returned no session") : result;
      }
      const input = pinnedInput(invocation);
      if (!input.ok) return rejected(input.error.detail);
      if (invocation.request.kind === INPUT_CONTRACTS.repository) {
        if (!isRecord(input.value) || typeof input.value.repository_path !== "string" || !(input.value.expected_head === null || typeof input.value.expected_head === "string")) return rejected("invalid RepositoryPreparationInput");
        const result = await repository.execute({ repository_path: input.value.repository_path, expected_head: input.value.expected_head }, call);
        return result.kind === "acknowledged" ? completed(found, invocation, result.value)
          : result.kind === "permanently_rejected" ? recovery(found, result, invocation) : result;
      }
      if (invocation.request.kind === INPUT_CONTRACTS.pull_request) {
        const query = isRecord(input.value) ? input.value.query : null;
        if (!query || !isRecord(query) || typeof query.owner !== "string" || typeof query.name !== "string" || typeof query.head_owner !== "string" || typeof query.head_branch !== "string" || typeof query.base_branch !== "string") return rejected("invalid PullRequestObservationInput");
        const result = await discovery.execute({ query: { owner: query.owner, name: query.name, head_owner: query.head_owner, head_branch: query.head_branch, base_branch: query.base_branch } }, call);
        return result.kind === "acknowledged" ? completed(found, invocation, result.value)
          : result.kind === "permanently_rejected" ? recovery(found, result, invocation) : result;
      }
      if (invocation.request.kind === INPUT_CONTRACTS.stub) return rejected(`unsupported operation ${contract.operation}`);
      const unhandled: never = invocation.request;
      return unhandled;
  }
  return {
    start: (invocation, call = {}) => invocation.request?.kind === INPUT_CONTRACTS.repository || invocation.request?.kind === INPUT_CONTRACTS.pull_request
      ? trackFinite(invocation, call) : startInvocation(invocation, call),
    async stop(invocation, handle, call = {}) {
      if (handle?.kind === "completed") return { kind: "acknowledged", value: { stopped: true } };
      if (invocation.request?.kind === INPUT_CONTRACTS.repository || invocation.request?.kind === INPUT_CONTRACTS.pull_request) {
        // Finite reads create no durable remote execution. Abort owned transports and
        // wait for IO completion before acknowledging that this provider owns none.
        const active = [...(active_finite_calls.get(invocation.id) ?? [])];
        for (const operation of active) operation.controller.abort(new Error("selected finite operation revoked"));
        await Promise.all(active.map((operation) => operation.finished));
        if (call.signal?.aborted) return { kind: "uncertain", detail: "cleanup deadline exceeded before finite IO completed" };
        return { kind: "acknowledged", value: { stopped: true } };
      }
      if (invocation.request?.kind !== INPUT_CONTRACTS.session) return { kind: "uncertain", detail: "unsupported long-lived provider cleanup" };
      return kbbl(call).stop_pinned({ request: { session_key: invocation.request.session_key, body: invocation.bytes },
        execution_id: invocation.execution_id as ExecutionId, reference: handle?.kind === INPUT_CONTRACTS.session ? handle : null });
    },
    async observe(invocation, handle, call = {}): Promise<ProviderResult<TerminalObservation>> {
      if (handle?.kind === "completed") return { kind: "acknowledged", value: { kind: "terminal", result: handle.result } };
      if (handle?.kind !== INPUT_CONTRACTS.session) return { kind: "uncertain", detail: "no external handle for terminal observation" };
      const result = await kbbl(call).observe_terminal(invocation.execution_id as ExecutionId, handle);
      if (result.kind === "executor_unavailable") return { kind: "transiently_unavailable", detail: result.detail };
      if (result.kind === "pending") return { kind: "acknowledged", value: { kind: "running" } };
      const found = await context(invocation);
      if (!found) return rejected("execution context missing");
      if (result.observation.kind !== "succeeded") {
        const code = result.observation.kind === "failed" ? result.observation.code
          : "code" in result.observation && typeof result.observation.code === "string" ? result.observation.code : "executor_cancelled";
        return recoverSessionFailure({ db: options.db, core: options.core, invocation,
          detail: `${code}: ${result.observation.detail ?? "session cancelled"}` });
      }
      // A session publishes its products through its selected output contract.
      // Its declared worker result remains unit, independent of adapter metadata.
      const finished = await completed(found, invocation, {});
      return finished.kind === "acknowledged" && finished.value.kind === "completed"
        ? { kind: "acknowledged", value: { kind: "terminal", result: finished.value.result, ...(finished.value.evidence ? { evidence: finished.value.evidence } : {}) } } : finished.kind === "acknowledged" ? rejected("terminal result missing") : finished;
    },
  };
}
