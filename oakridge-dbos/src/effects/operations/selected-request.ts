import { INPUT_CONTRACTS } from "../provider-catalog";
import type { CheckedValue, DefinitionBundle } from "../../core-client/generated-contracts";
import type { ExecutionRequest } from "../../domain/execution";
import type { ExecutionId, ExecutorOperationId, JsonValue, StageInstanceId, UnitId } from "../../domain/primitives";
import { renderSessionStart } from "../../adapters/kbbl";
import type { Result } from "../../storage/commit";
import { selectedPublicationInstructions } from "./selected-publication-contract";
import type { ScopeInstanceRecord } from "../../storage/schema-records";
import type { StableInvocation } from "../provider";
import { readPinnedPrompt } from "../../storage/storage-validator";

/** Reverse the checked wire representation using the same field indexes as the compiler. */
export function invocationInput(value: CheckedValue, bundle: DefinitionBundle): Result<JsonValue> {
  const data = value.data;
  const failure = (): Result<never> => ({ ok: false, error: { operation: "invocation_input", entity_id: value.schema, detail: "checked value does not match its stored schema" } });
  switch (data.kind) {
    case "boolean": case "integer": case "string": return { ok: true, value: data.value };
    case "enum": return { ok: true, value: data.variant };
    case "reference": return { ok: true, value: { brand: data.brand, id: data.id } };
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

export interface ProviderRequestSelection { readonly invocation: StableInvocation; readonly bundle: DefinitionBundle; readonly scope: Pick<ScopeInstanceRecord, "id" | "run_id" | "child_key" | "scope_key">; readonly publication_secret?: string }
/** Keep the selected action input in the pinned prompt so retries read identical context. */
export function promptWithActionInput(prompt: string, input: JsonValue): string {
  return `${prompt}\n\n## Pinned action input\n\n${JSON.stringify(input, null, 2)}\n`;
}
export function pinProviderRequest(input: ProviderRequestSelection): Result<StableInvocation> {
  const { invocation, bundle, scope, publication_secret } = input;
  const unit_id = scope.child_key ?? scope.id;
  const decoded = invocationInput(invocation.selection.input, bundle);
  if (!decoded.ok) return decoded;
  const contract = invocation.selection.definition;
  const prompt_key = invocation.selection.prompt_key;
  const prompt = prompt_key == null ? null : bundle.prompts.find((item) => item.key === prompt_key);
  if (prompt_key != null && !prompt) return { ok: false, error: { operation: "pin_request", entity_id: invocation.id, detail: "pinned prompt missing" } };
  const prompt_content = prompt ? readPinnedPrompt(prompt) : { ok: true as const, value: "" };
  if (!prompt_content.ok) return { ok: false, error: { ...prompt_content.error, operation: "pin_request" } };
  const isRecord = (value: JsonValue): value is { readonly [key: string]: JsonValue } => !!value && typeof value === "object" && !Array.isArray(value);
  const decoded_config = isRecord(decoded.value) && decoded.value.config && isRecord(decoded.value.config) ? decoded.value.config : decoded.value;
  const manifest = bundle.operations.find((item) => item.key === contract.operation && item.version === contract.contract_version);
  if (!manifest) return { ok: false, error: { operation: "pin_request", entity_id: invocation.id, detail: "pinned operation manifest missing" } };
  if (manifest.input_contract === INPUT_CONTRACTS.session) {
    if (!isRecord(decoded_config)) return { ok: false, error: { operation: "pin_request", entity_id: invocation.id, detail: "kbbl launch input must be a record" } };
    const request: ExecutionRequest = { execution_id: invocation.execution_id as ExecutionId, stage_instance_id: scope.id as StageInstanceId,
      unit_id: unit_id as UnitId, executor_type: "delegated_session", resolved_config: { ...decoded_config,
        session_identity: { run_id: scope.run_id, stage_instance_id: scope.id, unit_id,
          cohort_id: scope.child_key, operator_role: invocation.selection.selection.worker },
        rendered_prompt: (prompt ? promptWithActionInput(prompt_content.value, decoded.value) : "")
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
