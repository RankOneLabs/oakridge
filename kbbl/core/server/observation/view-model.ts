import type { ObservationError, Result, Resolution } from "./revision-address";

export interface GradeObservationView {
  readonly observation_id: string;
  readonly evaluator_definition_id: string;
  readonly answer: { readonly state: string; readonly kind: string; readonly value?: unknown; readonly reason?: string };
  readonly label_origin: string;
}

export type GradeSlot =
  | { readonly tag: "not_ingested" }
  | { readonly tag: "loading" }
  | { readonly tag: "unavailable"; readonly detail: string }
  | { readonly tag: "unauthorized" }
  | { readonly tag: "stale"; readonly current_revision_id: string; readonly graded_revision_id: string }
  | { readonly tag: "inapplicable"; readonly reason: string }
  | { readonly tag: "missing_evidence"; readonly reason: string }
  | { readonly tag: "queued" }
  | { readonly tag: "running" }
  | { readonly tag: "failed"; readonly detail: string }
  | { readonly tag: "no_eligible_question" }
  | { readonly tag: "ready"; readonly observations: readonly GradeObservationView[] };

export interface ArtifactItemSummary {
  readonly resolution: Resolution;
  readonly grade: GradeSlot;
  readonly eligibility: readonly EligibilityView[];
}
export interface EligibilityView { readonly tag: string; readonly question_id: string;
  readonly question_version: string; readonly payload: unknown }

/** This is the single grade-state transform shared by all observation surfaces. */
export function gradeSlot(input: {
  readonly state: GradeSlot["tag"];
  readonly current_revision_id: string;
  readonly occurrence_revision_id: string;
  readonly observations: readonly GradeObservationView[];
  readonly reason?: string;
}): Result<GradeSlot> {
  const { state, current_revision_id, occurrence_revision_id, observations, reason } = input;
  if (current_revision_id !== occurrence_revision_id) return { ok: true, value: {
    tag: "stale", current_revision_id, graded_revision_id: occurrence_revision_id } };
  switch (state) {
    case "not_ingested": return { ok: true, value: { tag: "not_ingested" } };
    case "loading": return { ok: true, value: { tag: "loading" } };
    case "unavailable": return { ok: true, value: { tag: "unavailable", detail: reason ?? "observation unavailable" } };
    case "unauthorized": return { ok: true, value: { tag: "unauthorized" } };
    case "stale": return { ok: true, value: { tag: "stale", current_revision_id, graded_revision_id: occurrence_revision_id } };
    case "inapplicable": return { ok: true, value: { tag: "inapplicable", reason: reason ?? "inapplicable" } };
    case "missing_evidence": return { ok: true, value: { tag: "missing_evidence", reason: reason ?? "missing evidence" } };
    case "queued": return { ok: true, value: { tag: "queued" } };
    case "running": return { ok: true, value: { tag: "running" } };
    case "failed": return { ok: true, value: { tag: "failed", detail: reason ?? "evaluation failed" } };
    case "no_eligible_question": return { ok: true, value: { tag: "no_eligible_question" } };
    case "ready": return { ok: true, value: { tag: "ready", observations } };
  }
  const _exhaustive: never = state;
  return { ok: false, error: { operation: "grade_slot", entity_id: current_revision_id,
    detail: `unhandled grade state ${String(_exhaustive)}` } satisfies ObservationError };
}
