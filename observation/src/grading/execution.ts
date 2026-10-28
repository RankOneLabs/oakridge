import { canonicalDigest } from "../canonical/canonical-json";
import type { EvidenceSetId, ExecutionId, ItemOccurrenceId, QuestionId } from "../domain/identity";
import type { CanonicalizationError } from "../domain/errors";
import type { JsonValue, Result } from "../domain/primitives";

export interface EvaluationIdentity {
  readonly subject_occurrence_id: ItemOccurrenceId;
  readonly evidence_set_id: EvidenceSetId;
  readonly question_id: QuestionId;
  readonly question_version: string;
  readonly evaluator_definition_id: string;
  readonly config_digest: string;
  readonly attempt_label: string;
}
export interface EvaluationExecution extends EvaluationIdentity {
  readonly execution_id: ExecutionId;
  readonly idempotency_digest: string;
  readonly attempts: number;
  readonly retries: number;
  readonly started_at: Date;
  readonly ended_at: Date | null;
  readonly status: "running" | "completed" | "failed";
  readonly error: string | null;
  readonly model_usage: JsonValue | null;
  readonly cost: number | null;
  readonly external_execution_id: string | null;
  readonly provider_link: string | null;
  readonly reproducibility_metadata: JsonValue | null;
}
export function evaluationDigest(identity: EvaluationIdentity): Result<string, CanonicalizationError> {
  return canonicalDigest([identity.subject_occurrence_id, identity.evidence_set_id, identity.question_id,
    identity.question_version, identity.evaluator_definition_id, identity.config_digest, identity.attempt_label]);
}
