// Generated from observation/src/http/grading-api.ts. Run bun kbbl/scripts/generate-grading-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { ObservationArtifactRevisionId, ObservationEvaluatorDefinitionId, ObservationEvidenceSetId, ObservationExecutionId, ObservationGradeObservationId, ObservationItemOccurrenceId, ObservationLogicalItemId, ObservationRelationId, ObservationReviewerId, ObservationRunId, ObservationUnitId } from "../domain/identity";
import type { ObservationJsonValue } from "../domain/primitives";
import type { ObservationEvidenceSet } from "./evidence";
import type { ObservationExecutionTerminalCause } from "./execution";
import type { ObservationGradeAnswer } from "./observation";
import type { ObservationQuestionKey } from "./question";
import type { ObservationAssociationProvenance } from "./task-association";
import type { ObservationStageState } from "./task-stages";
import type { ObservationRelationType } from "../projection/extractor";

export interface ObservationPaged<Item> extends ObservationPageRequest { readonly items: readonly Item[]; readonly total: number }

export interface ObservationPageRequest { readonly limit: number; readonly offset: number }

export interface ObservationLogicalItemLineage extends ObservationPaged<ObservationLineageEntry> {
  readonly run_id: ObservationRunId;
  readonly scope: string;
  readonly producer_local_id: string;
  /** False when items name this id but the run has captured no logical item for it. */
  readonly is_captured: boolean;
}

export type ObservationLineageEntry =
  /** The logical item's own occurrence in a defining revision. */
  | { readonly kind: "occurrence"; readonly artifact_kind: string; readonly item_kind: string; readonly revision_id: ObservationArtifactRevisionId; readonly item_path: string; readonly occurrence_id: ObservationItemOccurrenceId; readonly unit_id: ObservationUnitId | null; readonly is_current: boolean }
  /** An edge such an occurrence declared; `unresolved_target_ref` keeps a target not captured visible. */
  | { readonly kind: "edge"; readonly relation: ObservationCompositeRelation; readonly revision_id: ObservationArtifactRevisionId; readonly item_path: string }
  /** An item linked to it, current or superseded, with the explicit edge that links them. */
  | { readonly kind: "contribution"; readonly item: ObservationContributionItem; readonly provenance: ObservationAssociationProvenance }
  /** An item that named this logical item before any such item was captured. */
  | { readonly kind: "unresolved"; readonly item: ObservationContributionItem; readonly relation_id: ObservationRelationId; readonly unresolved_target_ref: string; readonly evidence_ref: string };

export interface ObservationCompositeDrilldownKey { readonly logical_item_id: ObservationLogicalItemId; readonly stage: string; readonly selector: ObservationCompositeSelector }

export type ObservationCompositeSelector =
  | { readonly kind: "items" }
  | { readonly kind: "history" }
  | { readonly kind: "answer"; readonly question: ObservationQuestionKey; readonly grader: ObservationGraderKey; readonly answer: ObservationAnswerKey }
  | { readonly kind: "status"; readonly question: ObservationQuestionKey; readonly evaluator_definition_id: ObservationEvaluatorDefinitionId | null; readonly status: ObservationItemStatusKey }
  | { readonly kind: "disagreement"; readonly question: ObservationQuestionKey };

export interface ObservationContributionItem {
  readonly occurrence_id: ObservationItemOccurrenceId;
  readonly revision_id: ObservationArtifactRevisionId;
  readonly item_path: string;
  readonly artifact_kind: string;
  readonly item_kind: string;
  readonly selected_value: ObservationJsonValue;
  readonly stage: string;
  readonly unit_id: ObservationUnitId;
  readonly is_current: boolean;
  readonly provenance: ObservationAssociationProvenance | null;
}

export interface ObservationUnresolvedReference { readonly item: ObservationContributionItem; readonly relation_id: ObservationRelationId; readonly unresolved_target_ref: string; readonly evidence_ref: string }

export interface ObservationLogicalItemComposite {
  readonly run_id: ObservationRunId;
  readonly logical_item_id: ObservationLogicalItemId;
  readonly scope: string;
  readonly producer_local_id: string;
  readonly coverage: "linked" | "gap";
  readonly stages: readonly ObservationStageComposite[];
}

export type ObservationStageComposite = ObservationStageState & {
  readonly stage: string;
  readonly publication: ObservationStagePublication;
  readonly results: readonly ObservationScopedResult[];
  readonly totals: ObservationStageTotals;
  readonly questions: readonly ObservationQuestionSummary[];
  readonly answers: readonly ObservationAnswerCount[];
  readonly statuses: readonly ObservationStatusCount[];
  readonly disagreements: readonly ObservationDisagreementCount[];
  readonly items: ObservationCompositeDrilldownKey;
  readonly history: ObservationCompositeDrilldownKey;
}

export interface ObservationCompositeRelation {
  readonly relation_id: ObservationRelationId;
  readonly source_occurrence_id: ObservationItemOccurrenceId;
  readonly target_occurrence_id: ObservationItemOccurrenceId | null;
  readonly target_logical_item_id: ObservationLogicalItemId | null;
  readonly unresolved_target_ref: string | null;
  readonly type: ObservationRelationType;
  readonly asserted_by: string;
  readonly evidence_ref: string;
}

export type ObservationSubjectScope = { readonly kind: "per_task"; readonly task_id: ObservationLogicalItemId } | { readonly kind: "per_item" };

export interface ObservationQuestionSummary extends ObservationQuestionKey { readonly item_kind: string; readonly question_text: string | null; readonly allowed_values: readonly ObservationJsonValue[] | null }

export interface ObservationScopedResult {
  readonly item: ObservationContributionItem;
  readonly scope: ObservationSubjectScope;
  readonly question: ObservationQuestionSummary;
  readonly evaluator: ObservationCompositeEvaluator | null;
  readonly evidence_set_id: ObservationEvidenceSetId;
  readonly provenance: ObservationAssociationProvenance;
  readonly status: ObservationItemStatusKey | { readonly state: "pinned" } | { readonly state: "answered"; readonly answer: ObservationCompositeAnswer };
}

export interface ObservationAnswerDetail extends ObservationCompositeAnswer { readonly grader: ObservationGraderKey }

export interface ObservationMeasurementRead {
  readonly task_id: ObservationLogicalItemId | null;
  readonly question: ObservationQuestionKey;
  readonly evidence: ObservationEvidenceSet;
  /** Null for a question's own not-ready status, which every evaluator of it shares. */
  readonly evaluator_definition_id: ObservationEvaluatorDefinitionId | null;
  readonly execution_id: ObservationExecutionId | null;
  readonly status: ObservationItemStatusKey;
  readonly detail: string | null;
}

export type ObservationGraderKey =
  | { readonly kind: "machine"; readonly evaluator_definition_id: ObservationEvaluatorDefinitionId; readonly backend_kind: string; readonly model: string | null }
  | { readonly kind: "human"; readonly evaluator_definition_id: ObservationEvaluatorDefinitionId; readonly reviewer_id: ObservationReviewerId };

export type ObservationAnswerKey =
  | { readonly state: "answered"; readonly value: ObservationJsonValue }
  | { readonly state: "abstain" | "unclear" };

export type ObservationItemStatusKey =
  | { readonly state: "not_ready"; readonly code: string }
  | { readonly state: "grading_off" }
  | { readonly state: "awaiting_admission" }
  | { readonly state: "pending" }
  | { readonly state: "budget_deferred" }
  | { readonly state: "failed"; readonly terminal_cause: ObservationExecutionTerminalCause | null };

export type ObservationStagePublication =
  | { readonly state: "pending" }
  /** `is_final` comes from the stage and the run alone: answers, links and approvals never decide it. */
  | { readonly state: "published"; readonly is_final: boolean; readonly unit_ids: readonly ObservationUnitId[] };

export interface ObservationStageTotals {
  readonly contributing_items: number;
  readonly not_ready_items: number;
  readonly pending_items: number;
  readonly failed_items: number;
  readonly budget_deferred_items: number;
  readonly grading_off_items: number;
  readonly superseded_items: number;
  readonly superseded_answers: number;
}

export interface ObservationAnswerCount { readonly question: ObservationQuestionSummary; readonly grader: ObservationGraderKey; readonly answer: ObservationAnswerKey; readonly count: number; readonly drilldown: ObservationCompositeDrilldownKey }

export interface ObservationStatusCount { readonly question: ObservationQuestionSummary; readonly evaluator_definition_id: ObservationEvaluatorDefinitionId | null; readonly status: ObservationItemStatusKey; readonly count: number; readonly drilldown: ObservationCompositeDrilldownKey }

export interface ObservationDisagreementCount { readonly question: ObservationQuestionSummary; readonly item_count: number; readonly drilldown: ObservationCompositeDrilldownKey }

export interface ObservationCompositeEvaluator {
  readonly evaluator_definition_id: ObservationEvaluatorDefinitionId;
  readonly kind: "model" | "code" | "human";
  readonly backend_kind: string;
  readonly provider: string;
  readonly model: string | null;
}

export interface ObservationCompositeAnswer {
  readonly task_id: ObservationLogicalItemId | null;
  readonly observation_id: ObservationGradeObservationId;
  readonly execution_id: ObservationExecutionId;
  readonly occurrence_id: ObservationItemOccurrenceId;
  readonly evidence_set_id: ObservationEvidenceSetId;
  readonly question: ObservationQuestionKey;
  readonly evaluator_definition_id: ObservationEvaluatorDefinitionId;
  readonly reviewer_id: ObservationReviewerId | null;
  readonly answer: ObservationGradeAnswer;
  readonly supersedes_observation_id: ObservationGradeObservationId | null;
  readonly confidence: number | null;
  readonly rationale: string | null;
  readonly comments: string | null;
  readonly recorded_at: string;
}
