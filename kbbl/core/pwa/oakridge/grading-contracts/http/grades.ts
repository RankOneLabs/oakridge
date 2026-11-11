// Generated from observation/src/http/grading-api.ts. Run bun kbbl/scripts/generate-grading-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { ObservationGradeObservationId, ObservationLogicalItemId, ObservationQuestionId, ObservationReviewerId } from "../domain/identity";
import type { ObservationErrorBody } from "./errors";
import type { ObservationRecordedSubmission, ObservationSubmissionRefusal } from "../storage/grading-store";

export interface ObservationReviewerRead { readonly reviewer_id: ObservationReviewerId }

export interface ObservationHumanSubmissionRequest {
  readonly task_id?: ObservationLogicalItemId | null;
  readonly question_id: ObservationQuestionId;
  readonly question_version: string;
  readonly submission_id: string;
  readonly answer: string;
  readonly rationale?: string | null;
  /** The reviewer's own current answer this one replaces; absent or null for a first answer. */
  readonly corrects_observation_id?: ObservationGradeObservationId | null;
}

export interface ObservationHumanSubmissionAcknowledgment extends Omit<ObservationRecordedSubmission, "recorded_at"> {
  readonly status: "recorded" | "duplicate";
  readonly recorded_at: string;
}

export interface ObservationSubmissionRefusalBody extends ObservationErrorBody { readonly error: ObservationErrorBody["error"] & { readonly refusal: ObservationSubmissionRefusal } }
