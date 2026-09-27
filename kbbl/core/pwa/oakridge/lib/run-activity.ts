import { parseOakridgeRunEventFrame } from "../client";
import type { RunEvent, RunEventOperation } from "../types";

const PAGE_SIZE = 500;

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
  | { readonly kind: "loaded"; readonly items: readonly RunActivityItem[] }
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

/** Read one run's durable ledger to exhaustion; `/run_events` is ascending and paged. */
export async function fetchRunEvents(runId: string): Promise<readonly RunEvent[]> {
  const events: RunEvent[] = [];
  let after: string | null = null;
  while (true) {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE), run_id: runId });
    if (after !== null) query.set("after", after);
    const response = await fetch(`/oakridge/api/run_events?${query.toString()}`);
    if (!response.ok) throw new Error(`run activity: ${response.status}`);
    const body: unknown = await response.json();
    if (!Array.isArray(body)) throw new Error("run activity response was not a list");
    const page = body.map((value) => {
      const event = parseOakridgeRunEventFrame(JSON.stringify({ ...value, replayed: true }));
      if (event === null) throw new Error("run activity response contained an invalid event");
      return event as RunEvent;
    });
    events.push(...page);
    if (page.length < PAGE_SIZE) return events;
    after = page[page.length - 1]?.sequence ?? after;
  }
}
