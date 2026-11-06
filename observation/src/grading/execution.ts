import type { EvidenceSetId, ExecutionId, ItemOccurrenceId, QuestionId } from "../domain/identity";
import type { JsonValue } from "../domain/primitives";

/** Mirrors the evaluation_execution baseline; admission and processing arrive in grading-pipeline. */
export interface EvaluationExecution {
  readonly execution_id: ExecutionId;
  readonly subject_occurrence_id: ItemOccurrenceId;
  readonly evidence_set_id: EvidenceSetId;
  readonly question_id: QuestionId;
  readonly question_version: string;
  readonly evaluator_definition_id: string;
  readonly attempt_label: string;
  readonly idempotency_digest: string;
  readonly run_id: string;
  readonly runner_name: string | null;
  readonly estimated_cost: number;
  readonly lease_owner: string | null;
  readonly lease_expires_at: Date | null;
  readonly retry_limit: number;
  readonly next_attempt_at: Date;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly attempts: number;
  readonly started_at: Date;
  readonly ended_at: Date | null;
  readonly status: "queued" | "claimed" | "reclaimable" | "budget_deferred" | "completed" | "failed";
  readonly error: string | null;
  readonly model_usage: JsonValue | null;
  readonly cost: number | null;
  readonly external_execution_id: string | null;
  readonly provider_link: string | null;
  readonly reproducibility_metadata: JsonValue | null;
}
