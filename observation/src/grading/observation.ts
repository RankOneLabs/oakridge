import type { EvidenceSetId, ExecutionId, GradeObservationId, ItemOccurrenceId, QuestionId } from "../domain/identity";
import type { JsonValue } from "../domain/primitives";
import type { EvaluationExecution } from "./execution";
import type { EvaluatorDefinition } from "./evaluator";
import type { ResponseKind } from "./question";

export type GradeAnswer =
  | { readonly state: "answered"; readonly kind: "boolean"; readonly value: boolean }
  | { readonly state: "answered"; readonly kind: "choice"; readonly value: string }
  | { readonly state: "answered"; readonly kind: "ordinal"; readonly value: string }
  | { readonly state: "answered"; readonly kind: "numeric"; readonly value: number }
  | { readonly state: "answered"; readonly kind: "text"; readonly value: string }
  | { readonly state: "answered"; readonly kind: "structured"; readonly value: JsonValue }
  | { readonly state: "abstain" | "unclear"; readonly kind: ResponseKind; readonly reason: string };
export interface GradeObservation {
  readonly observation_id: GradeObservationId;
  readonly answer: GradeAnswer;
  readonly probabilities: Readonly<Record<string, number>> | null;
  readonly confidence: number | null;
  readonly normalized_score: number | null;
  readonly decision_policy_id: string | null;
  readonly decision_policy_version: string | null;
  readonly reviewer_id: string | null;
  readonly reviewer_details: JsonValue | null;
  readonly comments: string | null;
  readonly rationale: string | null;
  readonly quality_flags: readonly string[];
  readonly supersedes_observation_id: GradeObservationId | null;
}

/** The grades read contract mirrors the joined grading rows after JSON serialization. */
export interface GradeObservationListing extends Omit<GradeObservation, "answer" | "probabilities" | "quality_flags"> {
  readonly collection_mode: "blind" | "in_context" | "unknown";
  readonly blind_assignment_id: string | null;
  readonly model_answers_visible: boolean | null;
  readonly workflow_decisions_visible: boolean | null;
  readonly label_origin: "oakridge_operator_unblinded" | "langfuse_annotation_blinded" | "other";
  readonly producer: string;
  readonly namespace: string;
  readonly execution_id: ExecutionId;
  readonly subject_occurrence_id: ItemOccurrenceId;
  readonly evidence_set_id: EvidenceSetId;
  readonly question_id: QuestionId;
  readonly question_version: string;
  readonly evaluator_definition_id: string;
  readonly answer_kind: ResponseKind;
  readonly answer_state: GradeAnswer["state"];
  readonly answer_payload: GradeAnswer;
  readonly probabilities: JsonValue | null;
  readonly quality_flags: JsonValue;
  readonly recorded_at: string;
}
export interface GradeListingItem {
  readonly observation: GradeObservationListing;
  readonly answer: GradeAnswer;
  readonly evaluator: EvaluatorDefinition & {
    readonly producer: string;
    readonly namespace: string;
    readonly identity_digest: string;
  };
  readonly execution: Omit<EvaluationExecution, "started_at" | "ended_at"> & {
    readonly producer: string;
    readonly namespace: string;
    readonly started_at: string;
    readonly ended_at: string | null;
  };
}
