// Mirrors the read and submission contracts in observation/src/grading/item-reads.ts,
// observation/src/grading/composite.ts and observation/src/http/grades.ts. The PWA imports no backend
// source, so these are named here against that one source.

/** One complete list's slice. `total` is always the whole list's size. */
export interface Paged<Item> { readonly items: readonly Item[]; readonly total: number; readonly limit: number; readonly offset: number }
export interface PageWindow { readonly limit: number; readonly offset: number }

/** The one address of an item: an exact revision and path. It names no task, cohort or link. */
export interface ItemSelection { readonly source_revision_id: string; readonly item_path: string }
export interface QuestionKey { readonly question_id: string; readonly question_version: string }

export interface AddressedItem extends ItemSelection {
  readonly occurrence_id: string;
  readonly revision_id: string;
  readonly artifact_kind: string;
  readonly item_kind: string;
  readonly selected_value: unknown;
  readonly stage: string;
  readonly unit_id: string;
  readonly is_current: boolean;
}

export type TaskLink =
  | { readonly state: "resolved"; readonly producer_local_id: string; readonly logical_item_id: string; readonly relation_id: string; readonly evidence_ref: string }
  | { readonly state: "unresolved"; readonly producer_local_id: string; readonly unresolved_target_ref: string; readonly relation_id: string; readonly evidence_ref: string };

interface ReferenceFields { readonly ref: string; readonly content: unknown }
export type EvidenceReference =
  | ReferenceFields & { readonly source: "revision"; readonly revision_id: string; readonly item_path: string | null }
  | ReferenceFields & { readonly source: "run_input"; readonly run_id: string; readonly input_path: string }
  | ReferenceFields & { readonly source: "repository"; readonly repository_key: string; readonly commit_sha: string; readonly path: string;
    readonly line_range: { readonly start: number; readonly end: number } | null; readonly is_absent: boolean }
  | ReferenceFields & { readonly source: "reported"; readonly reported_by: "agent"; readonly revision_id: string; readonly item_path: string };

export type EvidenceReadiness =
  | { readonly state: "ready"; readonly ready_at: string }
  | { readonly state: "not_ready"; readonly reason: { readonly code: string; readonly detail: string } };
export interface EvidenceRead extends QuestionKey {
  readonly evidence_set_id: string;
  readonly subject_occurrence_id: string;
  readonly pinned_evaluator_definition_ids: Paged<string>;
  readonly readiness: EvidenceReadiness;
  readonly references: Paged<EvidenceReference>;
  readonly is_incomplete: boolean;
  readonly incompleteness_reason: string | null;
}

export type GradeAnswer =
  | { readonly state: "answered"; readonly kind: string; readonly value: unknown }
  | { readonly state: "abstain" | "unclear"; readonly kind: string; readonly reason: string };
export type GraderKey =
  | { readonly kind: "machine"; readonly evaluator_definition_id: string; readonly backend_kind: string; readonly model: string | null }
  | { readonly kind: "human"; readonly evaluator_definition_id: string; readonly reviewer_id: string };
export interface AnswerRead {
  readonly observation_id: string;
  readonly execution_id: string;
  readonly occurrence_id: string;
  readonly evidence_set_id: string;
  readonly question: QuestionKey;
  readonly evaluator_definition_id: string;
  readonly reviewer_id: string | null;
  readonly answer: GradeAnswer;
  readonly supersedes_observation_id: string | null;
  readonly confidence: number | null;
  readonly rationale: string | null;
  readonly comments: string | null;
  readonly recorded_at: string;
  readonly grader: GraderKey;
  /** Only the item read marks this; a drilldown separates its lists instead. */
  readonly is_current?: boolean;
}

/** One machine evaluator's state for one question. Absence of an answer is never an answer. */
export type MeasurementState =
  | { readonly state: "not_ready"; readonly code: string; readonly detail: string }
  | { readonly state: "grading_off" }
  | { readonly state: "awaiting_admission" }
  | { readonly state: "pending"; readonly status: "queued" | "claimed" | "reclaimable" }
  | { readonly state: "budget_deferred" }
  | { readonly state: "failed"; readonly terminal_cause: string | null; readonly error: string }
  | { readonly state: "answered"; readonly observation_id: string; readonly answer: GradeAnswer };
export interface AttemptRead {
  readonly attempt: number;
  readonly request_sent: boolean;
  readonly outcome: "completed" | "failed" | null;
  readonly failure_category: string | null;
  readonly charged_cost: number;
  readonly admitted_estimate: number;
  readonly provider_request_id: string | null;
}
export interface MachineStatus {
  readonly evaluator_definition_id: string;
  readonly backend_kind: string;
  readonly model: string | null;
  readonly execution_id: string | null;
  readonly measurement: MeasurementState;
  readonly attempts: Paged<AttemptRead>;
}
export type HumanReadiness =
  | { readonly state: "ready" }
  | { readonly state: "not_ready"; readonly code: string; readonly detail: string }
  | { readonly state: "no_human_evaluator" };
export interface QuestionDefinition extends QuestionKey {
  readonly item_kind: string;
  readonly question_text: string | null;
  readonly response_kind: string;
  readonly allowed_values: readonly string[] | null;
  readonly interpretation_caveats: string;
  readonly unclear_semantics: string;
}
export interface QuestionStatus {
  readonly question: QuestionDefinition;
  readonly evidence: EvidenceRead;
  readonly human: HumanReadiness;
  readonly machine: Paged<MachineStatus>;
  readonly answers: Paged<AnswerRead>;
  readonly superseded_answers: Paged<AnswerRead>;
}
export interface ItemStatus {
  readonly item: AddressedItem;
  readonly is_grading_enabled: boolean;
  readonly links: Paged<TaskLink>;
  readonly questions: Paged<QuestionStatus>;
}
export type ItemStatusWindowName = "questions" | "references" | "pinned_evaluators" | "machine" | "attempts" | "answers" | "superseded_answers" | "links";

export interface ItemLineage extends PageWindow {
  readonly occurrence_id: string;
  readonly relations: readonly { readonly relation_id: string; readonly type: string; readonly asserted_by: string; readonly evidence_ref: string;
    readonly target_logical_item_id: string | null; readonly target_occurrence_id: string | null; readonly unresolved_target_ref: string | null }[];
  readonly total: number;
  readonly republication: { readonly predecessor_revision_id: string; readonly is_republication: boolean } | null;
}

export interface RunGradingState {
  readonly run_id: string;
  readonly is_grading_enabled: boolean;
  readonly committed: number;
  readonly requests_sent: number;
  readonly attempts: number;
  readonly executions: Readonly<Record<string, number>>;
}

// ---------------------------------------------------------------- composites ---

export type AnswerKey = { readonly state: "answered"; readonly value: unknown } | { readonly state: "abstain" | "unclear" };
export type ItemStatusKey =
  | { readonly state: "not_ready"; readonly code: string }
  | { readonly state: "grading_off" | "awaiting_admission" | "pending" | "budget_deferred" }
  | { readonly state: "failed"; readonly terminal_cause: string | null };
export type DrilldownSelector =
  | { readonly kind: "items" | "history" }
  | { readonly kind: "answer"; readonly question: QuestionKey; readonly grader: GraderKey; readonly answer: AnswerKey }
  | { readonly kind: "status"; readonly question: QuestionKey; readonly evaluator_definition_id: string | null; readonly status: ItemStatusKey }
  | { readonly kind: "disagreement"; readonly question: QuestionKey };
export interface DrilldownKey { readonly logical_item_id: string; readonly stage: string; readonly selector: DrilldownSelector }
export interface AnswerCount { readonly question: QuestionKey; readonly grader: GraderKey; readonly answer: AnswerKey; readonly count: number; readonly drilldown: DrilldownKey }
export interface StatusCount { readonly question: QuestionKey; readonly evaluator_definition_id: string | null; readonly status: ItemStatusKey; readonly count: number; readonly drilldown: DrilldownKey }
export interface DisagreementCount { readonly question: QuestionKey; readonly item_count: number; readonly drilldown: DrilldownKey }
export interface StageTotals {
  readonly contributing_items: number;
  readonly not_ready_items: number;
  readonly pending_items: number;
  readonly failed_items: number;
  readonly budget_deferred_items: number;
  readonly grading_off_items: number;
  readonly superseded_items: number;
  readonly superseded_answers: number;
}
export type StagePublication =
  | { readonly state: "pending" }
  | { readonly state: "published"; readonly is_final: boolean; readonly unit_ids: Paged<string> };
export interface StageComposite {
  readonly stage: string;
  readonly publication: StagePublication;
  readonly coverage: "linked" | "gap";
  readonly totals: StageTotals;
  readonly questions: Paged<QuestionKey & { readonly question_text: string | null }>;
  readonly answers: Paged<AnswerCount>;
  readonly statuses: Paged<StatusCount>;
  readonly disagreements: Paged<DisagreementCount>;
  readonly items: DrilldownKey;
  readonly history: DrilldownKey;
}
export interface TaskComposite {
  readonly run_id: string;
  readonly logical_item_id: string;
  readonly scope: string;
  readonly producer_local_id: string;
  readonly coverage: "linked" | "gap";
  readonly stages: Paged<StageComposite>;
}
export type CompositeWindowName = "stages" | "unit_ids" | "questions" | "answers" | "statuses" | "disagreements";

export interface DrilldownStatus { readonly question: QuestionKey; readonly evaluator_definition_id: string | null; readonly execution_id: string | null; readonly status: ItemStatusKey; readonly detail: string | null }
export interface DrilldownQuestion {
  readonly question: QuestionKey;
  readonly evidence: EvidenceRead;
  readonly statuses: Paged<DrilldownStatus>;
  readonly answers: Paged<AnswerRead>;
  readonly superseded_answers: Paged<AnswerRead>;
}
export interface DrilldownRow { readonly item: AddressedItem; readonly links: Paged<unknown>; readonly questions: Paged<DrilldownQuestion> }
export type DrilldownWindowName = "questions" | "links" | "statuses" | "answers" | "superseded_answers" | "references" | "pinned_evaluators";

export interface FindingRow { readonly item: AddressedItem; readonly links: Paged<TaskLink> }
export interface UnresolvedTaskReference { readonly item: AddressedItem; readonly relation_id: string; readonly unresolved_target_ref: string; readonly evidence_ref: string }
export type TaskLineageEntry =
  | { readonly kind: "occurrence"; readonly artifact_kind: string; readonly item_kind: string; readonly revision_id: string; readonly item_path: string; readonly occurrence_id: string; readonly unit_id: string; readonly is_current: boolean }
  | { readonly kind: "edge"; readonly relation: { readonly relation_id: string; readonly type: string; readonly evidence_ref: string }; readonly revision_id: string; readonly item_path: string }
  | { readonly kind: "contribution"; readonly item: Omit<AddressedItem, "source_revision_id">; readonly relation_id: string; readonly evidence_ref: string; readonly asserted_by: string }
  | { readonly kind: "unresolved"; readonly item: Omit<AddressedItem, "source_revision_id">; readonly relation_id: string; readonly unresolved_target_ref: string; readonly evidence_ref: string };
export interface TaskLineage extends Paged<TaskLineageEntry> { readonly run_id: string; readonly producer_local_id: string; readonly is_captured: boolean }

// --------------------------------------------------------------- submission ---

export interface AnswerSubmission extends QuestionKey {
  readonly submission_id: string;
  readonly answer: string;
  readonly rationale: string | null;
  readonly corrects_observation_id: string | null;
}
/** The only response on which the operator may be told an answer is saved. */
export interface SubmissionAcknowledgment {
  readonly status: "recorded" | "duplicate";
  readonly submission_id: string;
  readonly reviewer_id: string;
  readonly observation_id: string;
  readonly execution_id: string;
  readonly evidence_set_id: string;
  readonly occurrence_id: string;
  readonly question: QuestionKey;
  readonly answer: GradeAnswer;
  readonly rationale: string | null;
  readonly corrects_observation_id: string | null;
  readonly recorded_at: string;
}
export type SubmissionResult =
  | { readonly kind: "acknowledged"; readonly acknowledgment: SubmissionAcknowledgment }
  /** The service answered and recorded nothing, saying why. */
  | { readonly kind: "refused"; readonly code: string; readonly message: string }
  /** No answer came back, so nothing is known to be saved. */
  | { readonly kind: "failed"; readonly message: string };
