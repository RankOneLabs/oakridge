// Generated from observation/src/http/grading-api.ts. Run bun kbbl/scripts/generate-grading-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { ObservationArtifactRevisionId, ObservationEvaluatorDefinitionId, ObservationEvidenceSetId, ObservationExecutionId, ObservationItemOccurrenceId, ObservationLogicalItemId, ObservationRelationId } from "../domain/identity";
import type { ObservationJsonValue } from "../domain/primitives";
import type { ObservationAnswerDetail, ObservationCompositeRelation, ObservationContributionItem, ObservationLogicalItemComposite, ObservationMeasurementRead, ObservationPaged, ObservationStageComposite, ObservationUnresolvedReference } from "./composite";
import type { ObservationEvidenceReference } from "./evidence";
import type { ObservationQuestionDefinition, ObservationQuestionKey } from "./question";

export interface ObservationAddressedItem extends ObservationContributionItem, ObservationItemAddress {}

export interface ObservationItemAddress { readonly source_revision_id: ObservationArtifactRevisionId; readonly item_path: string; readonly task_id?: ObservationLogicalItemId | null }

export interface ObservationGradeableItemRow { readonly item: ObservationAddressedItem; readonly links: ObservationPaged<ObservationLogicalLinkRead> }

export interface ObservationUnresolvedReferenceRead extends Omit<ObservationUnresolvedReference, "item"> { readonly item: ObservationAddressedItem }

export interface ObservationCompositeRead extends Omit<ObservationLogicalItemComposite, "stages"> { readonly stages: ObservationPaged<ObservationStageCompositeRead> }

export interface ObservationStageCompositeRead extends Omit<ObservationStageComposite, "publication" | "questions" | "answers" | "statuses" | "disagreements"> {
  readonly publication: ObservationStagePublicationRead;
  readonly questions: ObservationPaged<ObservationStageComposite["questions"][number]>;
  readonly answers: ObservationPaged<ObservationStageComposite["answers"][number]>;
  readonly statuses: ObservationPaged<ObservationStageComposite["statuses"][number]>;
  readonly disagreements: ObservationPaged<ObservationStageComposite["disagreements"][number]>;
}

export interface ObservationDrilldownRowRead {
  readonly item: ObservationAddressedItem;
  readonly links: ObservationPaged<ObservationCompositeRelation>;
  readonly questions: ObservationPaged<ObservationDrilldownQuestionRead>;
}

export interface ObservationDrilldownQuestionRead {
  readonly task_id: ObservationLogicalItemId | null;
  readonly is_linked_context: boolean;
  readonly question: ObservationQuestionKey;
  readonly evidence: ObservationEvidenceRead;
  readonly statuses: ObservationPaged<ObservationMeasurementStatusRead>;
  readonly answers: ObservationPaged<ObservationAnswerDetail>;
  readonly superseded_answers: ObservationPaged<ObservationAnswerDetail>;
}

export type ObservationMeasurementStatusRead = Omit<ObservationMeasurementRead, "evidence">;

export interface ObservationAnswerRead extends ObservationAnswerDetail { readonly is_current: boolean }

export type ObservationLogicalLinkRead =
  | { readonly state: "resolved"; readonly producer_local_id: string; readonly logical_item_id: ObservationLogicalItemId; readonly relation_id: ObservationRelationId; readonly evidence_ref: string }
  | { readonly state: "unresolved"; readonly producer_local_id: string; readonly unresolved_target_ref: string; readonly relation_id: ObservationRelationId; readonly evidence_ref: string };

export type ObservationStagePublicationRead =
  | { readonly state: "pending" }
  | { readonly state: "published"; readonly is_final: boolean; readonly unit_ids: ObservationPaged<string> };

export interface ObservationEvidenceRead extends ObservationQuestionKey {
  readonly evidence_set_id: ObservationEvidenceSetId;
  readonly subject_occurrence_id: ObservationItemOccurrenceId;
  readonly task_id: ObservationLogicalItemId | null;
  readonly pinned_evaluator_definition_ids: ObservationPaged<ObservationEvaluatorDefinitionId>;
  readonly readiness: ObservationEvidenceReadinessRead;
  readonly references: ObservationPaged<ObservationEvidenceReference>;
  readonly is_incomplete: boolean;
  readonly incompleteness_reason: string | null;
}

export interface ObservationItemStatusRead<Measurement = ObservationJsonValue, Attempt = ObservationJsonValue> {
  readonly item: ObservationAddressedItem;
  readonly is_grading_enabled: boolean;
  readonly links: ObservationPaged<ObservationLogicalLinkRead>;
  readonly questions: ObservationPaged<ObservationQuestionStatusRead<Measurement, Attempt>>;
}

export interface ObservationQuestionStatusRead<Measurement = ObservationJsonValue, Attempt = ObservationJsonValue> {
  readonly task_id: ObservationLogicalItemId | null;
  readonly question: ObservationQuestionDefinition;
  readonly evidence: ObservationEvidenceRead;
  readonly human: ObservationHumanReadiness;
  readonly machine: ObservationPaged<ObservationMachineStatusRead<Measurement, Attempt>>;
  readonly answers: ObservationPaged<ObservationAnswerRead>;
  readonly superseded_answers: ObservationPaged<ObservationAnswerRead>;
}

export interface ObservationMachineStatusRead<Measurement, Attempt> {
  readonly evaluator_definition_id: ObservationEvaluatorDefinitionId;
  readonly backend_kind: string;
  readonly model: string | null;
  readonly execution_id: ObservationExecutionId | null;
  readonly measurement: Measurement;
  readonly attempts: ObservationPaged<Attempt>;
}

export type ObservationEvidenceReadinessRead =
  | { readonly state: "ready"; readonly ready_at: string }
  | { readonly state: "not_ready"; readonly reason: { readonly code: string; readonly detail: string } };

export type ObservationHumanReadiness =
  | { readonly state: "ready" }
  | { readonly state: "not_ready"; readonly code: string; readonly detail: string }
  /** The question was pinned with no human evaluator, so no reviewer can answer it. */
  | { readonly state: "no_human_evaluator" };
