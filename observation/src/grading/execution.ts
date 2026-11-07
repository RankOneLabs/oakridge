import { canonicalDigest } from "canonical-json";
import type { EvaluatorDefinitionId, EvidenceSetId, ExecutionId, ItemOccurrenceId, QuestionId } from "../domain/identity";
import type { CanonicalizationError } from "../domain/errors";
import type { JsonValue, Result } from "../domain/primitives";

/** What one measurement measures. Grades read this through their execution. */
export interface EvaluationIdentity {
  readonly subject_occurrence_id: ItemOccurrenceId;
  readonly evidence_set_id: EvidenceSetId;
  readonly question_id: QuestionId;
  readonly question_version: string;
  readonly evaluator_definition_id: EvaluatorDefinitionId;
  readonly attempt_label: string;
}
export type ExecutionStatus = "queued" | "claimed" | "reclaimable" | "budget_deferred" | "completed" | "failed";
export type ExecutionTerminalCause = "retry_exhausted" | "runner_failed" | "invalid_outcome";

/** Mirrors observation.evaluation_execution: one measurement and its only lifecycle record. */
export interface EvaluationExecution extends EvaluationIdentity {
  readonly execution_id: ExecutionId;
  readonly run_id: string;
  readonly idempotency_digest: string;
  readonly status: ExecutionStatus;
  readonly lease_owner: string | null;
  readonly lease_expires_at: Date | null;
  readonly attempts: number;
  readonly retries: number;
  readonly retry_limit: number;
  readonly estimated_cost: number;
  readonly terminal_cause: ExecutionTerminalCause | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly started_at: Date | null;
  readonly ended_at: Date | null;
  readonly error: string | null;
  readonly model_usage: JsonValue | null;
  readonly cost: number | null;
  readonly external_execution_id: string | null;
  readonly provider_link: string | null;
  readonly reproducibility_metadata: JsonValue | null;
}

/** Mirrors observation.grading_provider_attempt: one real request, apart from the measurement. */
export interface ProviderAttempt {
  readonly execution_id: ExecutionId;
  readonly attempt: number;
  readonly run_id: string;
  readonly request_sent: boolean;
  readonly outcome: "completed" | "failed" | null;
  readonly charged_cost: number;
  readonly admitted_estimate: number;
  readonly cost_overage: number;
  readonly provider_request_id: string | null;
  readonly failure_category: string | null;
}

export function evaluationDigest(identity: EvaluationIdentity): Result<string, CanonicalizationError> {
  return canonicalDigest([identity.subject_occurrence_id, identity.evidence_set_id, identity.question_id,
    identity.question_version, identity.evaluator_definition_id, identity.attempt_label]);
}

/** A reviewer's submission is one execution, labelled so a resubmission lands on the same row. */
export interface ReviewerSubmission { readonly reviewer_id: string; readonly submission_id: string }
export function submissionAttemptLabel(submission: ReviewerSubmission): string {
  return `submission:${submission.submission_id}`;
}
/** Keyed by reviewer and submission alone, so a reused id can never become a second answer. */
export function submissionDigest(submission: ReviewerSubmission): Result<string, CanonicalizationError> {
  return canonicalDigest(["reviewer-submission/v1", submission.reviewer_id, submission.submission_id]);
}
