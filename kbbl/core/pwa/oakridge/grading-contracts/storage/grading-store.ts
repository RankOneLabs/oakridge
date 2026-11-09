// Generated from observation/src/http/grading-api.ts. Run bun kbbl/scripts/generate-grading-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { ObservationEvaluatorDefinitionId, ObservationEvidenceSetId, ObservationExecutionId, ObservationGradeObservationId, ObservationItemOccurrenceId, ObservationReviewerId, ObservationRunId } from "../domain/identity";
import type { ObservationJsonValue } from "../domain/primitives";
import type { ObservationGradeAnswer } from "../grading/observation";
import type { ObservationQuestionKey } from "../grading/question";

export interface ObservationRecordedSubmission {
  readonly submission_id: string;
  readonly reviewer_id: ObservationReviewerId;
  readonly observation_id: ObservationGradeObservationId;
  readonly execution_id: ObservationExecutionId;
  readonly evidence_set_id: ObservationEvidenceSetId;
  readonly evaluator_definition_id: ObservationEvaluatorDefinitionId;
  readonly occurrence_id: ObservationItemOccurrenceId;
  readonly run_id: ObservationRunId;
  readonly question: ObservationQuestionKey;
  readonly answer: ObservationGradeAnswer;
  readonly rationale: string | null;
  readonly corrects_observation_id: ObservationGradeObservationId | null;
  readonly recorded_at: string;
}

export type ObservationSubmissionRefusal =
  | { readonly kind: "item_not_found"; readonly occurrence_id: ObservationItemOccurrenceId }
  | { readonly kind: "question_not_pinned"; readonly question: ObservationQuestionKey }
  | { readonly kind: "not_ready"; readonly question: ObservationQuestionKey; readonly code: string; readonly detail: string }
  | { readonly kind: "invalid_answer"; readonly question: ObservationQuestionKey; readonly detail: string; readonly allowed_values: readonly ObservationJsonValue[] }
  | { readonly kind: "no_human_evaluator"; readonly question: ObservationQuestionKey }
  | { readonly kind: "not_correctable"; readonly corrects_observation_id: ObservationGradeObservationId; readonly detail: string }
  /** `current_observation_id` is null when the reviewer has no current answer left to correct. */
  | { readonly kind: "stale_correction"; readonly corrects_observation_id: ObservationGradeObservationId; readonly current_observation_id: ObservationGradeObservationId | null }
  | { readonly kind: "correction_required"; readonly current_observation_id: ObservationGradeObservationId };
