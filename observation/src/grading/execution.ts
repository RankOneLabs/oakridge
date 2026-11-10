import { canonicalDigest } from "canonical-json";
import type { EvaluatorDefinitionId, EvidenceSetId, ExecutionId, GradeObservationId, ItemOccurrenceId, QuestionId } from "../domain/identity";
import type { CanonicalizationError } from "../domain/errors";
import type { JsonValue, Result } from "../domain/primitives";
import type { EvidenceReadiness } from "./evidence";
import type { GradeAnswer } from "./observation";
import type { QuestionDefinition } from "./question";

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

/** The one question a reviewer may answer now: its own readiness and nothing else decides it. */
export function humanChoiceAnswer(question: QuestionDefinition, value: string): Result<GradeAnswer, string> {
  if (question.response_kind !== "choice" && question.response_kind !== "ordinal")
    return { ok: false, error: `question ${question.question_id}@${question.question_version} takes no selected answer` };
  const answer: GradeAnswer = { state: "answered", kind: question.response_kind, value };
  const problem = answerProblem(question, answer);
  return problem ? { ok: false, error: problem } : { ok: true, value: answer };
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

/** Every machine measurement is admitted under this one label, so its identity is fixed by the
 * occurrence, pinned question version, frozen evidence and pinned evaluator alone: re-admission
 * after replay or restart lands on the same row. */
export const AUTOMATIC_ATTEMPT_LABEL = "automatic";

/** One ready question of an enabled run, measured by one evaluator pinned when it was captured. */
export interface AdmissionCandidate {
  readonly run_id: string;
  readonly subject_occurrence_id: ItemOccurrenceId;
  readonly evidence_set_id: EvidenceSetId;
  readonly question_id: QuestionId;
  readonly question_version: string;
  readonly evaluator_definition_id: EvaluatorDefinitionId;
  /** The pinned definition's configured estimate for one provider call. */
  readonly estimated_cost: number;
}
/** What one admission pass over a run did. A run without automatic grading admits nothing. */
export type RunAdmission =
  | { readonly kind: "grading_off"; readonly run_id: string }
  | { readonly kind: "admitted"; readonly run_id: string; readonly admitted: readonly ExecutionId[]; readonly already_admitted: number };

export function automaticIdentity(candidate: AdmissionCandidate): EvaluationIdentity {
  return { subject_occurrence_id: candidate.subject_occurrence_id, evidence_set_id: candidate.evidence_set_id,
    question_id: candidate.question_id, question_version: candidate.question_version,
    evaluator_definition_id: candidate.evaluator_definition_id, attempt_label: AUTOMATIC_ATTEMPT_LABEL };
}

/**
 * The exact claim a worker holds. Every authoritative write after the claim is fenced to all three:
 * the same owner, the same claim attempt and a lease that has not expired. An execution id or a
 * worker name alone never settles anything.
 */
export interface ExecutionClaim {
  readonly execution_id: ExecutionId;
  readonly run_id: string;
  readonly lease_owner: string;
  readonly claim_attempt: number;
  readonly lease_expires_at: Date;
}
export type ClaimResult =
  | { readonly kind: "claimed"; readonly claim: ExecutionClaim }
  /** The next estimated request cannot fit the run's allowance; no request is made for it. */
  | { readonly kind: "budget_deferred"; readonly execution_id: ExecutionId; readonly run_id: string }
  /** The reclaimed execution had already spent its retries on real requests. */
  | { readonly kind: "retry_exhausted"; readonly execution_id: ExecutionId; readonly run_id: string }
  | { readonly kind: "idle" };

/** A provider failure as one attempt records it. */
export interface AttemptFailure {
  readonly category: string;
  readonly detail: string;
  readonly provider_request_id: string | null;
  readonly provider_cost: number | null;
}
/** How a settlement attempt ended. `stale_claim` writes nothing: the claim was no longer current. */
export type SettlementResult =
  | { readonly kind: "completed"; readonly execution_id: ExecutionId; readonly observation_id: GradeObservationId }
  | { readonly kind: "retry_queued"; readonly execution_id: ExecutionId; readonly retries: number }
  | { readonly kind: "failed"; readonly execution_id: ExecutionId; readonly terminal_cause: ExecutionTerminalCause }
  | { readonly kind: "stale_claim"; readonly execution_id: ExecutionId };

/** Failures a repeated request may cure. A request that is wrong in itself fails at once. */
const RETRYABLE: ReadonlySet<string> = new Set(["invalid_response", "invalid_choice", "rate_limit", "timeout", "transport", "http_error",
  "invalid_answer", "settlement_failed", "lease_expired"]);
const INVALID_OUTCOME: ReadonlySet<string> = new Set(["invalid_response", "invalid_choice", "invalid_answer"]);

export type FailureDisposition =
  | { readonly kind: "retry"; readonly retries: number }
  | { readonly kind: "fail"; readonly terminal_cause: ExecutionTerminalCause };
/** The persisted policy decides: retry while retries remain, otherwise end failed with no grade. */
export function failureDisposition(category: string, execution: { readonly retries: number; readonly retry_limit: number }): FailureDisposition {
  if (!RETRYABLE.has(category)) return { kind: "fail", terminal_cause: "runner_failed" };
  if (execution.retries < execution.retry_limit) return { kind: "retry", retries: execution.retries + 1 };
  return { kind: "fail", terminal_cause: INVALID_OUTCOME.has(category) ? "invalid_outcome" : "retry_exhausted" };
}

/** Why an answer cannot complete its pinned question, or null when it can. Negative and unclear
 * answers inside the allowed set are valid completed answers. */
export function answerProblem(question: QuestionDefinition, answer: GradeAnswer): string | null {
  if (answer.kind !== question.response_kind) return `answer kind ${answer.kind} differs from question kind ${question.response_kind}`;
  if (answer.state !== "answered") return answer.reason.length > 0 ? null : "an abstention needs a reason";
  if ((question.response_kind === "choice" || question.response_kind === "ordinal")
    && !(question.allowed_values ?? []).some((allowed) => allowed === answer.value))
    return `answer ${String(answer.value)} is not an allowed value of ${question.question_id}@${question.question_version}`;
  return null;
}

/** One measurement's status, as a later reader distinguishes them. Absence of an answer is never an answer. */
export type MeasurementState =
  | { readonly state: "not_ready"; readonly code: string; readonly detail: string }
  | { readonly state: "grading_off" }
  | { readonly state: "awaiting_admission" }
  | { readonly state: "pending"; readonly status: "queued" | "claimed" | "reclaimable" }
  | { readonly state: "budget_deferred" }
  | { readonly state: "failed"; readonly terminal_cause: ExecutionTerminalCause | null; readonly error: string }
  | { readonly state: "answered"; readonly observation_id: GradeObservationId; readonly answer: GradeAnswer };

export interface MeasurementInput {
  readonly readiness: EvidenceReadiness;
  readonly is_grading_enabled: boolean;
  readonly execution: Pick<EvaluationExecution, "status" | "terminal_cause" | "error"> | null;
  readonly observation: { readonly observation_id: GradeObservationId; readonly answer: GradeAnswer } | null;
}
export function measurementState(input: MeasurementInput): MeasurementState {
  if (input.readiness.state === "not_ready") return { state: "not_ready", ...input.readiness.reason };
  if (!input.is_grading_enabled) return { state: "grading_off" };
  const execution = input.execution;
  if (!execution) return { state: "awaiting_admission" };
  switch (execution.status) {
    case "queued": case "claimed": case "reclaimable": return { state: "pending", status: execution.status };
    case "budget_deferred": return { state: "budget_deferred" };
    case "failed": return { state: "failed", terminal_cause: execution.terminal_cause, error: execution.error ?? "" };
    case "completed": return input.observation ? { state: "answered", ...input.observation }
      : { state: "failed", terminal_cause: null, error: "completed execution has no answer" };
  }
}
