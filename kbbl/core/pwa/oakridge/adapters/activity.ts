import type { OperatorEventHistory, OperatorUnitHistory, OperatorUnitView } from "../operator-contracts";
import type { RunEventFrame, RunEventPayload } from "../types";
import { compositeId, fail, ok, type AdapterResult } from "./core";

const record = (value: unknown): value is { readonly [key: string]: unknown } =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const validEvent = (value: unknown): boolean => {
  if (!record(value)) return false;
  switch (value.kind) {
    case "launched": return Object.hasOwn(value, "input");
    case "worker_started": case "worker_ended": return typeof value.action === "string";
    case "revision_published": return typeof value.artifact === "string" && typeof value.unit === "string";
    case "operator_decided": return typeof value.review === "string" && typeof value.target === "string"
      && typeof value.decision === "string" && typeof value.unit === "string";
    case "retry_requested": return typeof value.unit === "string" && typeof value.worker === "string";
    case "cancel_requested": return true;
    default: return false;
  }
};

/** The v2 unit history is the durable source for the frozen run Activity pane. */
export function parseUnitHistory(value: unknown): AdapterResult<OperatorUnitHistory> {
  if (!record(value) || typeof value.unit_id !== "string" || !Array.isArray(value.events)
      || !(value.next_cursor === null || typeof value.next_cursor === "string")
      || !value.events.every((entry: unknown) => record(entry) && typeof entry.id === "string"
        && typeof entry.created_at === "string" && validEvent(entry.event)))
    return fail("parse unit history", "invalid v2 unit history");
  return ok(value as unknown as OperatorUnitHistory);
}

export interface UnitActivityHistory {
  readonly unit: OperatorUnitView;
  readonly events: readonly OperatorEventHistory[];
}
interface ActivityEntry {
  readonly id: string;
  readonly occurred_at: string;
  readonly operation: RunEventFrame["operation"];
  readonly payload: RunEventFrame["payload"];
}

const basePayload = (runId: string, unit: OperatorUnitView): RunEventPayload => ({
  run_id: runId as RunEventPayload["run_id"], run_unit_id: unit.unit_id,
  stage_instance_id: unit.stage === null ? null : compositeId({ kind: "stage", runId, unitId: unit.unit_id, name: unit.stage }),
  stage_key: unit.stage, unit_id: unit.collection_key ?? unit.unit_key,
  work_order_id: null, wait_id: null, output_name: null, collection_key: unit.collection_key,
  artifact_revision_id: null, attention: null, continuation: null, detail: null,
});

/** Converts only v2 events with a truthful v1 Activity equivalent. */
export function runActivityEvents(runId: string, histories: readonly UnitActivityHistory[]): RunEventFrame[] {
  const entries: ActivityEntry[] = histories.flatMap(({ unit, events }) => events.flatMap((entry): ActivityEntry[] => {
    const base = basePayload(runId, unit);
    const event = entry.event;
    switch (event.kind) {
      case "revision_published":
        return [{ id: entry.id, occurred_at: entry.created_at, operation: "slot_released" as const,
          payload: { ...base, output_name: event.artifact } }];
      case "operator_decided": {
        if (event.review === "admission") return [];
        const artifact = unit.artifacts.find((candidate) => candidate.latest_revision?.id === event.target);
        return [{ id: entry.id, occurred_at: entry.created_at, operation: "gate_decided" as const,
          payload: { ...base, stage_instance_id: base.stage_instance_id ?? unit.unit_id,
            stage_key: base.stage_key ?? "$root", wait_id: event.review,
            output_name: artifact?.artifact_key ?? event.review,
            artifact_revision_id: event.target, attention: "none" as const,
            continuation: "waiting" as const } }];
      }
      default:
        return [];
    }
  }));
  entries.sort((left, right) => left.occurred_at.localeCompare(right.occurred_at) || left.id.localeCompare(right.id));
  return entries.map((entry, index) => ({ sequence: String(index + 1), operation: entry.operation,
    occurred_at: entry.occurred_at, payload: entry.payload, replayed: true }) as RunEventFrame);
}
