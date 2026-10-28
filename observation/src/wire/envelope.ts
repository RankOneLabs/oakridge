import type { JsonValue } from "../domain/primitives";
import type { ArtifactRevisionId, CanonicalDigest, EvidenceSetId, ExecutionId, GradeObservationId, ItemOccurrenceId, QuestionId, RelationId, RunId } from "../domain/identity";

/** Wire shapes mirror the producer revision row and the item-address rules in docs/spec-02-handoff.md. */
export interface RevisionAddress { readonly run_id: RunId; readonly revision_id: ArtifactRevisionId }
export interface ItemAddress extends RevisionAddress { readonly item_id: string | null; readonly json_pointer: string | null }
export interface RevisionFields extends RevisionAddress {
  readonly artifact: string;
  readonly unit_id: string;
  readonly sequence: number;
  readonly predecessor_id: ArtifactRevisionId | null;
  readonly subject_id: ArtifactRevisionId | null;
  readonly digest: CanonicalDigest;
}
export type ArtifactRevisionEnvelope =
  | { readonly format: "observation.artifact-revision/v1"; readonly kind: "structured"; readonly payload: RevisionFields & { readonly body: JsonValue } }
  | { readonly format: "observation.artifact-revision/v1"; readonly kind: "text"; readonly payload: RevisionFields & { readonly body: string } };

export interface OccurrenceFields { readonly occurrence_id: ItemOccurrenceId; readonly address: RevisionAddress; readonly digest: CanonicalDigest }
export type ItemOccurrenceEnvelope =
  | { readonly format: "observation.item/v1"; readonly kind: "stable-id"; readonly payload: OccurrenceFields & { readonly item_id: string; readonly cohort_id: string | null } }
  | { readonly format: "observation.item/v1"; readonly kind: "json-pointer"; readonly payload: OccurrenceFields & { readonly pointer: string } }
  | { readonly format: "observation.item/v1"; readonly kind: "text-span"; readonly payload: OccurrenceFields & { readonly section: string; readonly start: number; readonly end: number } };

export type RelationEnvelope =
  | { readonly format: "observation.relation/v1"; readonly kind: "trace"; readonly payload: { readonly relation_id: RelationId; readonly source: ItemOccurrenceId; readonly target: ItemOccurrenceId; readonly field: string } }
  | { readonly format: "observation.relation/v1"; readonly kind: "predecessor"; readonly payload: { readonly relation_id: RelationId; readonly newer: ArtifactRevisionId; readonly older: ArtifactRevisionId } };

export interface EvidenceReference { readonly kind: "file" | "test" | "output"; readonly ref: string; readonly detail: string | null }
export type EvidenceSetEnvelope =
  | { readonly format: "observation.evidence-set/v1"; readonly kind: "context"; readonly payload: { readonly evidence_set_id: EvidenceSetId; readonly digest: CanonicalDigest; readonly revisions: readonly RevisionAddress[]; readonly references: readonly EvidenceReference[] } }
  | { readonly format: "observation.evidence-set/v1"; readonly kind: "repository"; readonly payload: { readonly evidence_set_id: EvidenceSetId; readonly digest: CanonicalDigest; readonly revisions: readonly RevisionAddress[]; readonly repository_key: string; readonly commit_sha: string; readonly references: readonly EvidenceReference[] } };

export interface QuestionFields { readonly question_id: QuestionId; readonly item: ItemOccurrenceId; readonly prompt: string; readonly evidence_set_id: EvidenceSetId }
export type QuestionEnvelope =
  | { readonly format: "observation.question/v1"; readonly kind: "choice"; readonly payload: QuestionFields & { readonly options: readonly { readonly key: string; readonly label: string }[] } }
  | { readonly format: "observation.question/v1"; readonly kind: "score"; readonly payload: QuestionFields & { readonly minimum: number; readonly maximum: number; readonly rubric: string } }
  | { readonly format: "observation.question/v1"; readonly kind: "free-text"; readonly payload: QuestionFields };

export interface ExecutionFields { readonly execution_id: ExecutionId; readonly question_id: QuestionId; readonly evaluator_id: string; readonly evidence_set_id: EvidenceSetId }
export type ExecutionEnvelope =
  | { readonly format: "observation.execution/v1"; readonly kind: "requested"; readonly payload: ExecutionFields & { readonly requested_at: string } }
  | { readonly format: "observation.execution/v1"; readonly kind: "succeeded"; readonly payload: ExecutionFields & { readonly completed_at: string; readonly provider_request_id: string | null } }
  | { readonly format: "observation.execution/v1"; readonly kind: "failed"; readonly payload: ExecutionFields & { readonly completed_at: string; readonly error: { readonly stage: "grade" | "validate" | "feedback_store" | "feedback_score"; readonly detail: string } } };

export type GradeAnswer =
  | { readonly kind: "choice"; readonly option_key: string }
  | { readonly kind: "score"; readonly value: number }
  | { readonly kind: "free-text"; readonly text: string };
export type GradeObservationEnvelope =
  | { readonly format: "observation.grade/v1"; readonly kind: "evaluator"; readonly payload: { readonly observation_id: GradeObservationId; readonly execution_id: ExecutionId; readonly answer: GradeAnswer; readonly rationale: string | null } }
  | { readonly format: "observation.grade/v1"; readonly kind: "human"; readonly payload: { readonly observation_id: GradeObservationId; readonly question_id: QuestionId; readonly reviewer_id: string; readonly answer: GradeAnswer; readonly rationale: string | null } };

export type ObservationEnvelope = ArtifactRevisionEnvelope | ItemOccurrenceEnvelope | RelationEnvelope | EvidenceSetEnvelope | QuestionEnvelope | ExecutionEnvelope | GradeObservationEnvelope;
