import { parseRunEvent } from "../wire";
import type { RunDetail, RunEvent } from "../types";

const PAGE_SIZE = 500;

export interface RunActivityItem {
  readonly sequence: string;
  readonly operation: string;
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

const contextOf = (event: RunEvent, run: RunDetail): string | null => {
  if (event.owner.kind === "run") return null;
  if (event.owner.kind === "stage_instance") {
    return run.stages.find((stage) => stage.stage_instance_id === event.owner.id)?.name ?? null;
  }
  for (const stage of run.stages) {
    const unit = stage.units?.find((candidate) => candidate.cohort_id === event.owner.id);
    if (unit) return `${stage.name} · ${unit.unit_id}`;
  }
  return null;
};

const summaryOf = (event: RunEvent): string | null => {
  const effect = event.effect;
  switch (effect.kind) {
    case "start_stage": return "Stage started";
    case "start_attempt": return event.launch_reason === "retry" ? "Retry launched" : `Session launched (attempt ${effect.attempt_number})`;
    case "cohort_transition":
      return `${effect.unit_label}: ${effect.from_state} → ${effect.to_state}`;
    case "none":
      return event.launch_reason === "gate_decided" ? "Gate decided"
        : event.launch_reason === "operator" ? "Operator action" : null;
    case "pull_request_observed": return "Pull request observed";
    case "pull_request_merge_confirmed": return "Pull request merge confirmed";
    case "unrecognized": return `Recorded ${effect.effect_kind}`;
    case "deliver_message":
    case "resume_wait": return null;
  }
};

export const selectRunActivity = (events: readonly RunEvent[], run: RunDetail): readonly RunActivityItem[] =>
  events.flatMap((event): RunActivityItem[] => {
    if (event.run_id !== run.id) return [];
    const summary = summaryOf(event);
    if (summary === null) return [];
    const effect = event.effect;
    return [{
      sequence: event.sequence, operation: effect.kind, occurred_at: event.occurred_at,
      summary, context: contextOf(event, run), is_optional_attention: false,
      pull_request_url: effect.kind === "pull_request_observed" || effect.kind === "pull_request_merge_confirmed"
        ? effect.pull_request_url : null,
    }];
  }).sort((left, right) => {
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
    const page = body.map(parseRunEvent);
    events.push(...page);
    if (page.length < PAGE_SIZE) return events;
    after = page[page.length - 1]?.sequence ?? after;
  }
}
