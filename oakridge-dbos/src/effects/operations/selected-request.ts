import { INPUT_CONTRACTS } from "../provider-catalog";
import type { DefinitionBundle } from "../../core-client/generated-contracts";
import { plainValue } from "../../core-client/plain-value";
import type { ExecutionRequest } from "../../domain/execution";
import type { ExecutionId, ExecutorOperationId, JsonValue, StageInstanceId, UnitId } from "../../domain/primitives";
import { renderSessionStart } from "../../adapters/kbbl";
import type { Result } from "../../storage/commit";
import { selectedPublicationInstructions } from "./selected-publication-contract";
import type { ScopeInstanceRecord } from "../../storage/schema-records";
import type { StableInvocation } from "../provider";
import type { PromptTexts } from "../../storage/prompt-content";
import { defaultModelForRuntime, type RuntimeId } from "../../../../kbbl/core/runtime";
import { resolveSessionSettings, type SessionInvocationSettings, type SessionPolicy } from "../../domain/session-settings";
import type { Invocation } from "../../core-client/generated-contracts";


/** `prompts` holds the stored text of every prompt the decision selected; a render never reads a prompt file. */
export interface ProviderRequestSelection { readonly invocation: StableInvocation; readonly bundle: DefinitionBundle; readonly prompts: PromptTexts; readonly scope: Pick<ScopeInstanceRecord, "id" | "run_id" | "child_key" | "collection_key" | "scope_key">; readonly publication_secret?: string }
const isRecord = (value: JsonValue): value is { readonly [key: string]: JsonValue } => !!value && typeof value === "object" && !Array.isArray(value);

/** Resolve from the action's selector and the policy read by the committing transaction. */
export function resolveSelectedSessionSettings(bundle: DefinitionBundle, selection: Invocation, scope: ProviderRequestSelection["scope"], policy: SessionPolicy): Result<SessionInvocationSettings | null> {
  const manifest = bundle.operations.find((item) => item.key === selection.definition.operation && item.version === selection.definition.contract_version);
  if (manifest?.input_contract !== INPUT_CONTRACTS.session) return { ok: true, value: null };
  const decoded = plainValue(selection.input, bundle);
  if (!decoded.ok) return decoded;
  if (!isRecord(decoded.value) || !isRecord(decoded.value.config)) return { ok: false, error: { operation: "resolve_session_settings", entity_id: scope.id, detail: "session action config missing" } };
  const config = decoded.value.config;
  if (config.runtime !== "claude-code" && config.runtime !== "codex") return { ok: false, error: { operation: "resolve_session_settings", entity_id: scope.id, detail: "session runtime missing" } };
  const runtime = config.runtime as RuntimeId;
  const other_runtime: RuntimeId = runtime === "codex" ? "claude-code" : "codex";
  const selector = isRecord(decoded.value.selector) ? decoded.value.selector : null;
  const stage_key = typeof selector?.stage_key === "string" ? selector.stage_key : scope.scope_key;
  const cohort_key = typeof selector?.cohort_key === "string" ? selector.cohort_key : scope.collection_key === null ? null : scope.child_key;
  const worker_key = typeof selector?.worker_key === "string" ? selector.worker_key : selection.selection.worker;
  const action_key = typeof selector?.action_key === "string" ? selector.action_key : selection.selection.action;
  if (stage_key !== scope.scope_key || worker_key !== selection.selection.worker || action_key !== selection.selection.action)
    return { ok: false, error: { operation: "resolve_session_settings", entity_id: scope.id, detail: "session selector disagrees with selected action" } };
  const resolved = resolveSessionSettings(policy, { stage_key, cohort_key, worker_key, action_key,
    worker_defaults: [{ runtime, model: defaultModelForRuntime(runtime) }, { runtime: other_runtime, model: defaultModelForRuntime(other_runtime) }] });
  if (!resolved.ok) return { ok: false, error: { operation: resolved.error.operation, entity_id: resolved.error.entity_id, detail: resolved.error.detail } };
  return { ok: true, value: { runtime: resolved.value.runtime, model: resolved.value.model, effort: resolved.value.effort, policy_version: policy.version } };
}
/** Keep the selected action input in the pinned prompt so retries read identical context. */
export function promptWithActionInput(prompt: string, input: JsonValue): string {
  return `${prompt}\n\n## Pinned action input\n\n${JSON.stringify(input, null, 2)}\n`;
}
export function pinProviderRequest(input: ProviderRequestSelection): Result<StableInvocation> {
  const { invocation, bundle, prompts, scope, publication_secret } = input;
  const unit_id = scope.child_key ?? scope.id;
  const decoded = plainValue(invocation.selection.input, bundle);
  if (!decoded.ok) return decoded;
  const contract = invocation.selection.definition;
  const prompt_key = invocation.selection.prompt_key;
  const prompt_content = prompt_key == null ? null : prompts.get(prompt_key);
  if (prompt_content === undefined) return { ok: false, error: { operation: "pin_request", entity_id: invocation.id, detail: "pinned prompt missing" } };
  const decoded_config = isRecord(decoded.value) && decoded.value.config && isRecord(decoded.value.config) ? decoded.value.config : decoded.value;
  const manifest = bundle.operations.find((item) => item.key === contract.operation && item.version === contract.contract_version);
  if (!manifest) return { ok: false, error: { operation: "pin_request", entity_id: invocation.id, detail: "pinned operation manifest missing" } };
  if (manifest.input_contract === INPUT_CONTRACTS.session) {
    if (!isRecord(decoded_config)) return { ok: false, error: { operation: "pin_request", entity_id: invocation.id, detail: "kbbl launch input must be a record" } };
    const request: ExecutionRequest = { execution_id: invocation.execution_id as ExecutionId, stage_instance_id: scope.id as string as StageInstanceId,
      unit_id: unit_id as UnitId, executor_type: "delegated_session", resolved_config: { ...decoded_config,
        runtime: invocation.session_settings?.runtime ?? decoded_config.runtime,
        model: invocation.session_settings?.model ?? null,
        effort: invocation.session_settings?.effort ?? null,
        session_identity: { run_id: scope.run_id, stage_instance_id: scope.id, unit_id,
          cohort_id: scope.child_key, operator_role: invocation.selection.selection.worker },
        rendered_prompt: (prompt_content === null ? "" : promptWithActionInput(prompt_content, decoded.value))
          + selectedPublicationInstructions({ invocation, bundle, scope, publication_secret }) },
      inputs: [], declared_outputs: [], expected_artifacts: [] };
    const rendered = renderSessionStart({ request, operation_id: invocation.id as unknown as ExecutorOperationId, executor_function_identity: "selected-v1" });
    if (rendered.kind !== "acknowledged") return { ok: false, error: { operation: "pin_request", entity_id: invocation.id, detail: rendered.detail } };
    return { ok: true, value: { ...invocation, bytes: rendered.value.body, request: { version: 1, kind: INPUT_CONTRACTS.session, session_key: rendered.value.session_key } } };
  }
  const kind = manifest.input_contract === INPUT_CONTRACTS.repository || manifest.input_contract === INPUT_CONTRACTS.pull_request
    ? manifest.input_contract : INPUT_CONTRACTS.stub;
  return { ok: true, value: { ...invocation, bytes: JSON.stringify(decoded.value), request: { version: 1, kind } } };
}
