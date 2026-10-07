import type { RunEventEffect } from "../../run-event-types";
import type { RunEventFrame } from "../../types";

export interface RunEventFrameOverrides {
  readonly run_id?: string;
  readonly effect?: RunEventEffect;
  readonly replayed?: boolean;
}

/** Shaped like a frame off GET /run_events, so a test varies only the part it is about. */
export const runEventFrame = ({ run_id = "run-one", effect = { kind: "none" }, replayed = false }: RunEventFrameOverrides = {}): RunEventFrame => ({
  sequence: "1", transition_id: "transition-1", run_id, owner: { kind: "run", id: run_id },
  launch_reason: "operator", prior_owner_version: 1, resulting_owner_version: 2,
  effect, effect_workflow_id: null, actor: "authority", occurred_at: "2026-01-01T00:00:00Z", replayed,
});

/** The transition variant, named so a test can vary one of its fields without widening to the union. */
export type CohortTransitionEffect = Extract<RunEventEffect, { readonly kind: "cohort_transition" }>;

export const operatorTransition: CohortTransitionEffect = { kind: "cohort_transition", cohort_id: "cohort-1",
  unit_label: "Review", event_kind: "advanced", from_state: "working", to_state: "awaiting_operator",
  next_actor: "operator", refusal: null };
