import type { CheckedValue, DefinitionBundle } from "../../core-client/generated-contracts";
import type { ExecutionRequest } from "../../domain/execution";
import type { ExecutionId, ExecutorOperationId, JsonValue, StageInstanceId, UnitId } from "../../domain/primitives";
import { renderSessionStart } from "../../adapters/kbbl";
import type { Result } from "../../storage/commit";
import type { StableInvocation } from "../provider";

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

export interface ProviderRequestSelection { readonly invocation: StableInvocation; readonly bundle: DefinitionBundle; readonly scope_id: string }
export function pinProviderRequest(input: ProviderRequestSelection): Result<StableInvocation> {
  const { invocation, bundle, scope_id } = input;
  const decoded = invocationInput(invocation.selection.input, bundle);
  if (!decoded.ok) return decoded;
  const contract = invocation.selection.definition;
  if (contract.provider === "kbbl") {
    if (!decoded.value || typeof decoded.value !== "object" || Array.isArray(decoded.value)) return { ok: false, error: { operation: "pin_request", entity_id: invocation.id, detail: "kbbl launch input must be a record" } };
    const request: ExecutionRequest = { execution_id: invocation.execution_id as ExecutionId, stage_instance_id: scope_id as StageInstanceId,
      unit_id: invocation.selection.selection.worker as UnitId, executor_type: "delegated_session", resolved_config: { ...decoded.value,
        ...(invocation.selection.prompt_content !== null && invocation.selection.prompt_content !== undefined ? { rendered_prompt: invocation.selection.prompt_content } : {}) },
      inputs: [], declared_outputs: [], expected_artifacts: [] };
    const rendered = renderSessionStart({ request, operation_id: invocation.id as unknown as ExecutorOperationId, executor_function_identity: "selected-v1" });
    if (rendered.kind !== "acknowledged") return { ok: false, error: { operation: "pin_request", entity_id: invocation.id, detail: rendered.detail } };
    return { ok: true, value: { ...invocation, bytes: rendered.value.body, request: { version: 1, kind: "kbbl_session", session_key: rendered.value.session_key } } };
  }
  const kind = contract.provider === "git" && contract.operation === "repository.prepare" ? "repository_preparation"
    : contract.provider === "github" && contract.operation === "pull_request.observe" ? "pull_request_observation" : "unsupported";
  return { ok: true, value: { ...invocation, bytes: JSON.stringify(decoded.value), request: { version: 1, kind } } };
}
