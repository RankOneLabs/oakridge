import type { CheckedValue, Trigger } from "../core-client/generated-contracts";
import { CORE_MAX_FRAME_BYTES, CORE_PROTOCOL_VERSION, decodeCoreResponse } from "../core-client/generated-contracts";
import type { CommittedReceipt, OutputPublication } from "../storage/commit";
import type { ScopeId } from "../storage/schema-records";
import { requestDigest } from "../storage/receipts";
import { MalformedRequestError } from "./scope-commands";

export interface PublicationRequest { readonly request_id: string; readonly expected_scope_version: number; readonly trigger: Trigger; readonly output: OutputPublication }
export function publicationRevisionId(run_id: string, scope_id: string, request_id: string): string {
  const hash = requestDigest({ run_id, scope_id, request_id });
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}`;
}
export interface PublicationReceipt {
  readonly kind: "accepted_pending";
  readonly request_id: string;
  readonly transition_id: CommittedReceipt["transition_id"];
  readonly scope_version: number;
  readonly revision_id: string | null;
}
export function publicationReceipt(request_id: string, receipt: CommittedReceipt, revision_id: string | null): PublicationReceipt {
  return { kind: "accepted_pending", request_id, transition_id: receipt.transition_id, scope_version: receipt.scope_version, revision_id };
}
/** A published value must fit the evaluate frame that will later carry it; the commit measures the whole snapshot. */
export const MAX_PUBLICATION_VALUE_BYTES = CORE_MAX_FRAME_BYTES;
export function publicationValueBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }
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
  const checked = (item: unknown): item is CheckedValue => decodeCoreResponse({ version: CORE_PROTOCOL_VERSION, request_id: "validate", truncated: false,
    result: { status: "ok", value: { kind: "validated", value: item } } }) !== null;
  if (!checked(payload) || !checked(body)) return new MalformedRequestError("publication requires checked values");
  return { request_id: value.request_id, expected_scope_version: value.expected_scope_version,
    trigger: value.trigger as Trigger, output: value.output as unknown as OutputPublication };
}
