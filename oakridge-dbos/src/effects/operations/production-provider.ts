import type { CheckedValue, DefinitionBundle, ScopeDefinition, Trigger } from "../../core-client/generated-contracts";
import type { CoreClient } from "../../core-client/client";
import type { ExecutionRequest } from "../../domain/execution";
import type { ExecutionId, JsonValue, StageInstanceId, UnitId } from "../../domain/primitives";
import type { SqlExecutor } from "../../storage/sql-executor";
import { KbblExecutorAdapter } from "../../adapters/kbbl";
import { BunGitCommandRunner } from "../../runtime/git-command-runner";
import { GithubPullRequestReader, type PullRequestReader } from "../../runtime/github-pull-requests";
import { RepositoryPreparationOperation } from "./repository-preparation";
import { PullRequestObservationOperation } from "./pull-request-observation";
import type { EffectProvider, ExternalHandle, ProviderResult, StableInvocation, TerminalObservation } from "../provider";
import type { Result } from "../../storage/commit";

export interface ProductionProviderOptions {
  readonly db: SqlExecutor;
  readonly core: CoreClient;
  readonly kbbl_base_url: string;
  readonly pull_requests?: PullRequestReader;
}
interface InvocationContext { readonly bundle: DefinitionBundle; readonly scope: ScopeDefinition; readonly scope_id: string; readonly run_id: string }
interface ContextRow { readonly source: DefinitionBundle; readonly scope_key: string; readonly scope_id: string; readonly run_id: string }

/** Reverse the checked wire representation using the same field indexes as the compiler. */
export function invocationInput(value: CheckedValue, bundle: DefinitionBundle): Result<JsonValue> {
  const data = value.data;
  const failure = (): Result<never> => ({ ok: false, error: { operation: "invocation_input", entity_id: value.schema, detail: "checked value does not match its stored schema" } });
  switch (data.kind) {
    case "boolean": case "integer": case "string": return { ok: true, value: data.value };
    case "enum": return { ok: true, value: data.variant };
    case "reference": return { ok: true, value: data.id };
    case "optional": return data.value ? invocationInput(data.value, bundle) : { ok: true, value: null };
    case "variant": {
      const result = invocationInput(data.value, bundle);
      return result.ok ? { ok: true, value: { kind: data.variant, value: result.value } } : result;
    }
    case "list": {
      const items: JsonValue[] = [];
      for (const item of data.items) { const result = invocationInput(item, bundle); if (!result.ok) return result; items.push(result.value); }
      return { ok: true, value: items };
    }
    case "record": {
      const shape = bundle.schemas.find((schema) => schema.key === value.schema)?.shape;
      if (shape?.kind !== "record") return failure();
      const record: { [key: string]: JsonValue } = {};
      for (const field of data.fields) {
        const definition = shape.fields[field.field_id];
        if (!definition) return failure();
        if (!field.value) continue;
        const result = invocationInput(field.value, bundle);
        if (!result.ok) return result;
        record[definition.key] = result.value;
      }
      for (const entry of data.dictionary) { const result = invocationInput(entry.value, bundle); if (!result.ok) return result; record[entry.key] = result.value; }
      return { ok: true, value: record };
    }
  }
}
const isRecord = (value: JsonValue): value is { [key: string]: JsonValue } => !!value && typeof value === "object" && !Array.isArray(value);
const rejected = (detail: string): ProviderResult<never> => ({ kind: "permanently_rejected", code: "invalid_invocation", detail });

export function createEffectProvider(options: ProductionProviderOptions): EffectProvider {
  const repository = new RepositoryPreparationOperation(new BunGitCommandRunner());
  const discovery = new PullRequestObservationOperation(options.pull_requests ?? new GithubPullRequestReader({ token: process.env.GITHUB_TOKEN ?? "" }));
  const kbbl = new KbblExecutorAdapter({ base_url: options.kbbl_base_url, executor_function_identity: "selected-v1" });
  async function context(invocation: StableInvocation): Promise<InvocationContext | null> {
    const rows = await options.db.query<ContextRow>("SELECT b.source,s.scope_key,s.id AS scope_id,s.run_id FROM authority.execution e JOIN authority.scope_instance s ON s.id=e.scope_id JOIN authority.run r ON r.id=s.run_id JOIN authority.definition_bundle b ON b.id=r.definition_bundle_id WHERE e.id=$1", [invocation.execution_id]);
    const row = rows[0];
    const scope = row?.source.scopes.find((scope) => scope.key === row.scope_key);
    return row && scope ? { bundle: row.source, scope, scope_id: row.scope_id, run_id: row.run_id } : null;
  }
  async function validate(context: InvocationContext, schema: string, payload: unknown): Promise<ProviderResult<CheckedValue>> {
    const result = await options.core.request("validate_payload", { bundle: context.bundle, available_operations: context.bundle.operations, schema, payload });
    if (!result.ok) return result.error.kind === "domain" ? rejected(JSON.stringify(result.error)) : { kind: "transiently_unavailable", detail: JSON.stringify(result.error) };
    return result.value.kind === "validated" ? { kind: "acknowledged", value: result.value.value } : rejected("core returned a non-validated operation result");
  }
  async function recovery(context: InvocationContext, result: ProviderResult<unknown>, invocation: StableInvocation): Promise<ProviderResult<never>> {
    if (result.kind !== "permanently_rejected") return rejected("expected a permanent rejection");
    const definition = context.scope.facts.find((fact) => fact.key === result.code);
    if (!definition) return result;
    const checked = await validate(context, definition.payload_schema, result.detail);
    if (checked.kind !== "acknowledged") return checked;
    const evidence: Trigger = { id: `${invocation.id}:error`, key: result.code, payload: checked.value };
    return { ...result, evidence };
  }
  async function completed(context: InvocationContext, invocation: StableInvocation, result: unknown): Promise<ProviderResult<ExternalHandle>> {
    const worker = context.scope.workers.find((worker) => worker.key === invocation.selection.selection.worker);
    if (!worker) return rejected("selected worker is not declared");
    const checked = await validate(context, worker.result_schema, result);
    if (checked.kind !== "acknowledged") return checked;
    const fact_key = invocation.selection.definition.settings.find((setting) => setting.key === "result_fact")?.value;
    const fact = fact_key ? context.scope.facts.find((fact) => fact.key === fact_key && fact.payload_schema === worker.result_schema) : null;
    if (fact_key && !fact) return rejected("result_fact must name a declared fact with the worker result schema");
    return { kind: "acknowledged", value: { kind: "completed", result: checked.value,
      ...(fact ? { evidence: { id: `${invocation.id}:result`, key: fact.key, payload: checked.value } } : {}) } };
  }
  function sessionRequest(context: InvocationContext, invocation: StableInvocation, input: JsonValue): ExecutionRequest | null {
    if (!isRecord(input)) return null;
    // All launch material is selected input; discovery and head reads never enrich a replay.
    return { execution_id: invocation.execution_id as ExecutionId, stage_instance_id: context.scope_id as StageInstanceId,
      unit_id: invocation.selection.selection.worker as UnitId, executor_type: "delegated_session", resolved_config: input,
      inputs: [], declared_outputs: [], expected_artifacts: [] };
  }
  return {
    async start(invocation) {
      const found = await context(invocation);
      if (!found) return rejected("execution context missing");
      const input = invocationInput(invocation.selection.input, found.bundle);
      if (!input.ok) return rejected(input.error.detail);
      const contract = invocation.selection.definition;
      if (contract.contract_version !== 1) return rejected("unsupported operation contract version");
      if (contract.provider === "git" && contract.operation === "repository.prepare") {
        if (!isRecord(input.value) || typeof input.value.repository_path !== "string" || !(input.value.expected_head === null || typeof input.value.expected_head === "string")) return rejected("invalid RepositoryPreparationInput");
        const result = await repository.execute({ repository_path: input.value.repository_path, expected_head: input.value.expected_head });
        return result.kind === "acknowledged" ? completed(found, invocation, result.value)
          : result.kind === "permanently_rejected" ? recovery(found, result, invocation) : result;
      }
      if (contract.provider === "github" && contract.operation === "pull_request.observe") {
        const query = isRecord(input.value) ? input.value.query : null;
        if (!query || !isRecord(query) || typeof query.owner !== "string" || typeof query.name !== "string" || typeof query.head_branch !== "string" || typeof query.base_branch !== "string") return rejected("invalid PullRequestObservationInput");
        const result = await discovery.execute({ query: { owner: query.owner, name: query.name, head_branch: query.head_branch, base_branch: query.base_branch } });
        return result.kind === "acknowledged" ? completed(found, invocation, result.value) : result;
      }
      if (contract.provider === "kbbl") {
        const request = sessionRequest(found, invocation, input.value);
        if (!request) return rejected("invalid selected kbbl launch input");
        const result = await kbbl.start_selected(request, invocation.id);
        return result.kind === "acknowledged" && result.value.kind === "kbbl_session" ? { kind: "acknowledged", value: result.value }
          : result.kind === "acknowledged" ? rejected("kbbl returned no session") : result;
      }
      return rejected(`unsupported operation ${contract.provider}/${contract.operation}`);
    },
    async stop(invocation, handle) {
      if (handle?.kind === "completed") return { kind: "acknowledged", value: { stopped: true } };
      const found = await context(invocation);
      if (!found) return { kind: "uncertain", detail: "execution context missing during cleanup" };
      if (invocation.selection.definition.provider !== "kbbl") return { kind: "uncertain", detail: "awaiting a terminal observation for the selected leaf operation" };
      const input = invocationInput(invocation.selection.input, found.bundle);
      if (!input.ok) return { kind: "uncertain", detail: input.error.detail };
      const request = sessionRequest(found, invocation, input.value);
      if (!request) return { kind: "uncertain", detail: "selected kbbl launch input is invalid" };
      return kbbl.stop_selected(request, invocation.id, handle?.kind === "kbbl_session" ? handle : null);
    },
    async observe(invocation, handle): Promise<ProviderResult<TerminalObservation>> {
      if (handle?.kind === "completed") return { kind: "acknowledged", value: { kind: "terminal", result: handle.result } };
      if (handle?.kind !== "kbbl_session") return { kind: "uncertain", detail: "no external handle for terminal observation" };
      const result = await kbbl.observe_terminal(invocation.execution_id as ExecutionId, handle);
      if (result.kind === "executor_unavailable") return { kind: "transiently_unavailable", detail: result.detail };
      if (result.kind === "pending") return { kind: "acknowledged", value: { kind: "running" } };
      const found = await context(invocation);
      if (!found) return rejected("execution context missing");
      const finished = await completed(found, invocation, result.observation);
      return finished.kind === "acknowledged" && finished.value.kind === "completed"
        ? { kind: "acknowledged", value: { kind: "terminal", result: finished.value.result, ...(finished.value.evidence ? { evidence: finished.value.evidence } : {}) } } : finished.kind === "acknowledged" ? rejected("terminal result missing") : finished;
    },
  };
}
