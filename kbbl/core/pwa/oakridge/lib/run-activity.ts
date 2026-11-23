import type { OperatorRecordedFeedbackDisposition } from "../operator-contracts/storage/read-store";
import { parseUnitViews } from "../adapters/parse";
import { parseUnitHistory, runActivityEvents, type UnitActivityHistory } from "../adapters/activity";
import { unwrap } from "../adapters/core";
import type { RunEvent, RunEventOperation } from "../run-types";


const ACTIVITY_OPERATIONS: ReadonlySet<RunEventOperation> = new Set([
  "input_revised",
  "slot_released",
  "slot_pending",
  "slot_invalidated",
  "gate_opened",
  "gate_decided",
  "pull_request_observed",
  "pull_request_merge_confirmed",
]);

export interface RunActivityItem {
  readonly sequence: string;
  readonly operation: RunEventOperation;
  readonly occurred_at: string;
  readonly summary: string;
  readonly context: string | null;
  readonly is_optional_attention: boolean;
  readonly pull_request_url: string | null;
}

export type RunActivityRead =
  | { readonly kind: "loaded"; readonly items: readonly RunActivityItem[]; readonly dispositions?: readonly OperatorRecordedFeedbackDisposition[] }
  | { readonly kind: "pending" }
  | { readonly kind: "unavailable" };

const summaries: Readonly<Record<RunEventOperation, string>> = {
  stage_materialized: "Stage materialized",
  materialization_closed: "Materialization closed",
  materialization_failed: "Materialization failed",
  run_cancelled: "Run cancelled",
  unit_admitted: "Unit admitted",
  operator_retry_created: "Unit retry created",
  input_revised: "Revision requested",
  slot_released: "Output published",
  slot_pending: "Publication awaiting review",
  slot_invalidated: "Publication invalidated",
  unit_satisfied: "Unit satisfied",
  work_started: "Work started",
  gate_opened: "Gate opened",
  gate_decided: "Gate decided",
  pull_request_observed: "Pull request observed",
  pull_request_merge_confirmed: "Pull request merge confirmed",
};

const contextOf = (event: RunEvent): string | null => {
  const parts = [event.payload.stage_key, event.payload.unit_id, event.payload.output_name]
    .filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
};

const pullRequestUrlOf = (event: RunEvent): string | null =>
  event.operation === "pull_request_observed" || event.operation === "pull_request_merge_confirmed"
    ? event.payload.detail.pull_request_url
    : null;

export const selectRunActivity = (
  events: readonly RunEvent[],
  runId: string,
): readonly RunActivityItem[] =>
  events
    .filter((event) => event.payload.run_id === runId && ACTIVITY_OPERATIONS.has(event.operation))
    .map((event) => ({
      sequence: event.sequence,
      operation: event.operation,
      occurred_at: event.occurred_at,
      summary: summaries[event.operation],
      context: contextOf(event),
      is_optional_attention:
        event.payload.attention === "optional" && event.payload.continuation === "continuing",
      pull_request_url: pullRequestUrlOf(event),
    }))
    .sort((left, right) => {
      const leftSequence = BigInt(left.sequence);
      const rightSequence = BigInt(right.sequence);
      return leftSequence === rightSequence ? 0 : leftSequence > rightSequence ? -1 : 1;
    });

/** Read the durable histories through the same unit routes as the operator views. */
export interface RunActivityHistory {
  readonly events: readonly RunEvent[];
  readonly dispositions: readonly OperatorRecordedFeedbackDisposition[];
}

export async function fetchRunEvents(runId: string): Promise<RunActivityHistory> {
  const unitsPath = `/oakridge/api/runs/${encodeURIComponent(runId)}/units`;
  const read = async (path: string): Promise<unknown> => {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`run activity: ${response.status}`);
    return response.json();
  };
  const units = unwrap(unitsPath, parseUnitViews(await read(unitsPath)));
  const histories = await Promise.all(units.map(async (unit): Promise<UnitActivityHistory> => {
    const events: UnitActivityHistory["events"][number][] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({ limit: String(100) });
      if (cursor !== null) params.set("cursor", cursor);
      const path = `${unitsPath}/${encodeURIComponent(unit.unit_id)}/history?${params}`;
      const page = unwrap(path, parseUnitHistory(await read(path)));
      if (page.unit_id !== unit.unit_id) throw new Error("run activity returned the wrong unit");
      events.push(...page.events);
      cursor = page.next_cursor;
    } while (cursor !== null);
    return { unit, events };
  }));
  const dispositions = histories.flatMap(({ events }) => events.flatMap((event) => event.feedback_dispositions ?? []))
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
  return { events: runActivityEvents(runId, histories), dispositions };
}
