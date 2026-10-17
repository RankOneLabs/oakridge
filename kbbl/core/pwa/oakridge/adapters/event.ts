import type { RunEventFrame, RunEventOperation } from "../types";
import { runEventKind } from "./core";

const RUN_EVENT_OPERATIONS: ReadonlySet<string> = new Set<RunEventOperation>([
  "stage_materialized", "materialization_closed", "materialization_failed", "run_cancelled", "unit_admitted",
  "operator_retry_created", "input_revised", "slot_released", "slot_pending", "slot_invalidated", "unit_satisfied",
  "work_started", "gate_opened", "gate_decided", "pull_request_observed", "pull_request_merge_confirmed",
]);

const nullableString = (value: unknown): value is string | null => value === null || typeof value === "string";
const isGateRunEventOperation = (operation: string): boolean => operation === "gate_opened" || operation === "gate_decided";
const isPullRequestRunEventOperation = (operation: string): boolean =>
  operation === "pull_request_observed" || operation === "pull_request_merge_confirmed";

const isJsonValue = (value: unknown): value is import("../types").JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object" && Object.values(value).every(isJsonValue);
};

const isJsonObject = (value: unknown): value is { readonly [key: string]: import("../types").JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every(isJsonValue);

/** Parse one server frame without allowing malformed stream data into UI subscribers. */
export const parseOakridgeRunEventFrame = (data: string): RunEventFrame | null => {
  let value: unknown;
  try { value = JSON.parse(data); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v2 = value as Partial<import("../operator-contracts").OperatorRunEvent> & { replay?: unknown };
  if (typeof v2.event_id === "string" && typeof v2.run_id === "string" && typeof v2.unit_id === "string"
      && typeof v2.unit_key === "string" && typeof v2.kind === "string" && typeof v2.occurred_at === "string"
      && typeof v2.replay === "boolean") {
    const mapped = runEventKind(v2 as import("../operator-contracts").OperatorRunEvent);
    return mapped.ok && mapped.value ? { ...mapped.value, replayed: v2.replay } : null;
  }
  const event = value as Partial<RunEventFrame>;
  if (typeof event.sequence !== "string" || !/^\d+$/.test(event.sequence) || typeof event.operation !== "string"
      || !RUN_EVENT_OPERATIONS.has(event.operation) || typeof event.occurred_at !== "string" || typeof event.replayed !== "boolean") return null;
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || typeof payload.run_id !== "string"
      || !nullableString(payload.run_unit_id) || !nullableString(payload.stage_instance_id) || !nullableString(payload.stage_key)
      || !nullableString(payload.unit_id) || !nullableString(payload.work_order_id) || !nullableString(payload.wait_id)
      || !nullableString(payload.output_name) || !nullableString(payload.collection_key) || !nullableString(payload.artifact_revision_id)
      || !(payload.attention === null || payload.attention === "required" || payload.attention === "optional" || payload.attention === "none")
      || !(payload.continuation === null || payload.continuation === "waiting" || payload.continuation === "continuing")
      || !isJsonValue(payload.detail)) return null;
  if (isGateRunEventOperation(event.operation)
      && (payload.run_unit_id === null || payload.stage_instance_id === null || payload.stage_key === null
        || payload.unit_id === null || payload.wait_id === null || payload.output_name === null
        || payload.artifact_revision_id === null || payload.attention === null || payload.continuation === null)) return null;
  if (isPullRequestRunEventOperation(event.operation)) {
    const detail = payload.detail;
    if (payload.run_unit_id === null || payload.stage_instance_id === null || payload.stage_key === null
        || payload.unit_id === null || payload.artifact_revision_id === null || !isJsonObject(detail)
        || typeof detail.repository_key !== "string"
        || typeof detail.pull_request_url !== "string" || typeof detail.state !== "string" || typeof detail.source !== "string"
        || !(detail.merged_at === null || typeof detail.merged_at === "string")) return null;
  }
  return event as RunEventFrame;
};
