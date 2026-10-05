import type { CheckedValue, Trigger } from "../core-client/generated-contracts";
import { decodeCoreResponse } from "../core-client/generated-contracts";
import type { OutputPublication } from "../storage/commit";
import type { ScopeId } from "../storage/schema-records";
import { MalformedRequestError } from "./scope-commands";

export interface PublicationRequest { readonly request_id: string; readonly expected_scope_version: number; readonly trigger: Trigger; readonly output: OutputPublication }
const object = (value: unknown): value is { readonly [key: string]: unknown } => !!value && typeof value === "object" && !Array.isArray(value);
const version = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export function parsePublication(value: unknown, scope_id: ScopeId): PublicationRequest | MalformedRequestError {
  if (!object(value) || typeof value.request_id !== "string" || !value.request_id || !version(value.expected_scope_version)
    || !object(value.trigger) || typeof value.trigger.key !== "string" || value.trigger.id !== value.request_id
    || !object(value.output) || value.output.scope_id !== scope_id || typeof value.output.output_key !== "string"
    || typeof value.output.collection_key !== "string" || !(value.output.predecessor_id === null || typeof value.output.predecessor_id === "string")
    || !(value.output.execution_id === null || typeof value.output.execution_id === "string")
    || !(value.output.expected_slot_version === null || version(value.output.expected_slot_version)))
    return new MalformedRequestError("invalid publication request");
  const payload = value.trigger.payload;
  const body = value.output.body;
  const checked = (item: unknown): item is CheckedValue => decodeCoreResponse({ version: 1, request_id: "validate", truncated: false,
    result: { status: "ok", value: { kind: "validated", value: item } } }) !== null;
  if (!checked(payload) || !checked(body)) return new MalformedRequestError("publication requires checked values");
  return { request_id: value.request_id, expected_scope_version: value.expected_scope_version,
    trigger: value.trigger as Trigger, output: value.output as unknown as OutputPublication };
}
