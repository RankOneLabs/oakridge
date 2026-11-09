/**
 * The named read contracts a client consumes: one item addressed by revision and path, its questions'
 * state, task composites and their drilldowns. Every function is pure over rows a store read. Each
 * returned list is `Paged` with a window of its own, so nothing unbounded hides inside a paged parent:
 * a reader continues one list while holding the others still.
 */
import type { EvaluatorDefinitionId, ItemOccurrenceId } from "../domain/identity";
import type { JsonValue } from "../domain/primitives";
import { pageOf, selectCurrentAnswers, type AnswerDetail, type CompositeLogicalItem, type CompositeRelation, type ContributionItem, type DrilldownRow, type LogicalItemComposite, type MeasurementRead,
  type PageRequest, type Paged, type StageComposite, type UnresolvedReference } from "./composite";
import type { EvidenceReference, EvidenceSet } from "./evidence";
import type { QuestionDefinition, QuestionKey } from "./question";

/** An item as a client addresses it: exactly one revision and path, with nothing tracked in it. */
export interface ItemAddress { readonly source_revision_id: string; readonly item_path: string }
export interface AddressedItem extends ContributionItem, ItemAddress {}
export const addressedItem = (item: ContributionItem): AddressedItem => ({ ...item, source_revision_id: item.revision_id });

/** One explicit edge from an item to a logical item. A reference with no captured target stays visible as unresolved. */
export type LogicalLinkRead =
  | { readonly state: "resolved"; readonly producer_local_id: string; readonly logical_item_id: string; readonly relation_id: string; readonly evidence_ref: string }
  | { readonly state: "unresolved"; readonly producer_local_id: string; readonly unresolved_target_ref: string; readonly relation_id: string; readonly evidence_ref: string };

const SCOPED_REFERENCE = /^logical_item:[^:]*:(?<id>.+)$/;
export function logicalLinks(relations: readonly CompositeRelation[], logical_items: readonly CompositeLogicalItem[]): readonly LogicalLinkRead[] {
  const byId = new Map(logical_items.map((item) => [item.logical_item_id, item]));
  return relations.flatMap((relation): readonly LogicalLinkRead[] => {
    if (relation.unresolved_target_ref !== null) return [{ state: "unresolved", producer_local_id: SCOPED_REFERENCE.exec(relation.unresolved_target_ref)?.groups?.id ?? relation.unresolved_target_ref,
      unresolved_target_ref: relation.unresolved_target_ref, relation_id: relation.relation_id, evidence_ref: relation.evidence_ref }];
    const target = relation.target_logical_item_id ? byId.get(relation.target_logical_item_id) : undefined;
    return target ? [{ state: "resolved", producer_local_id: target.producer_local_id, logical_item_id: target.logical_item_id, relation_id: relation.relation_id, evidence_ref: relation.evidence_ref }] : [];
  });
}

// ---------------------------------------------------------------- evidence ---

export type EvidenceReadiness =
  | { readonly state: "ready"; readonly ready_at: Date }
  | { readonly state: "not_ready"; readonly reason: { readonly code: string; readonly detail: string } };
/** The exact frozen references one question's answers all share. */
export interface EvidenceRead extends QuestionKey {
  readonly evidence_set_id: string;
  readonly subject_occurrence_id: ItemOccurrenceId;
  readonly pinned_evaluator_definition_ids: Paged<EvaluatorDefinitionId>;
  readonly readiness: EvidenceReadiness;
  readonly references: Paged<EvidenceReference>;
  readonly is_incomplete: boolean;
  readonly incompleteness_reason: string | null;
}
export interface EvidenceWindows { readonly references: PageRequest; readonly pinned_evaluators: PageRequest }
export const EVIDENCE_WINDOWS = ["references", "pinned_evaluators"] as const;
export const evidenceRead = (set: EvidenceSet, windows: EvidenceWindows): EvidenceRead => ({ question_id: set.question_id, question_version: set.question_version,
  evidence_set_id: set.evidence_set_id, subject_occurrence_id: set.subject_occurrence_id, pinned_evaluator_definition_ids: pageOf(set.pinned_evaluator_definition_ids, windows.pinned_evaluators),
  readiness: set.readiness.state === "ready" ? { state: "ready", ready_at: set.readiness.ready_at } : { state: "not_ready", reason: set.readiness.reason },
  references: pageOf(set.readiness.state === "ready" ? set.readiness.references : [], windows.references),
  is_incomplete: set.is_incomplete, incompleteness_reason: set.incompleteness_reason });

// ------------------------------------------------------------- composites ---

export type StagePublicationRead =
  | { readonly state: "pending" }
  | { readonly state: "published"; readonly is_final: boolean; readonly unit_ids: Paged<string> };
export interface StageCompositeRead extends Omit<StageComposite, "publication" | "questions" | "answers" | "statuses" | "disagreements"> {
  readonly publication: StagePublicationRead;
  readonly questions: Paged<StageComposite["questions"][number]>;
  readonly answers: Paged<StageComposite["answers"][number]>;
  readonly statuses: Paged<StageComposite["statuses"][number]>;
  readonly disagreements: Paged<StageComposite["disagreements"][number]>;
}
export interface CompositeRead extends Omit<LogicalItemComposite, "stages"> { readonly stages: Paged<StageCompositeRead> }
export const COMPOSITE_WINDOWS = ["stages", "unit_ids", "questions", "answers", "statuses", "disagreements"] as const;
export type CompositeWindows = Record<(typeof COMPOSITE_WINDOWS)[number], PageRequest>;
const stageRead = (stage: StageComposite, windows: CompositeWindows): StageCompositeRead => ({ ...stage,
  publication: stage.publication.state === "published" ? { ...stage.publication, unit_ids: pageOf(stage.publication.unit_ids, windows.unit_ids) } : stage.publication,
  questions: pageOf(stage.questions, windows.questions), answers: pageOf(stage.answers, windows.answers),
  statuses: pageOf(stage.statuses, windows.statuses), disagreements: pageOf(stage.disagreements, windows.disagreements) });
export const compositeRead = (composite: LogicalItemComposite, windows: CompositeWindows): CompositeRead =>
  ({ ...composite, stages: pageOf(composite.stages.map((stage) => stageRead(stage, windows)), windows.stages) });

// -------------------------------------------------------------- drilldowns ---

export type MeasurementStatusRead = Omit<MeasurementRead, "evidence">;
export interface DrilldownQuestionRead {
  readonly question: QuestionKey;
  readonly evidence: EvidenceRead;
  readonly statuses: Paged<MeasurementStatusRead>;
  readonly answers: Paged<AnswerDetail>;
  readonly superseded_answers: Paged<AnswerDetail>;
}
export interface DrilldownRowRead {
  readonly item: AddressedItem;
  readonly links: Paged<CompositeRelation>;
  readonly questions: Paged<DrilldownQuestionRead>;
}
export const drilldownRowRead = (row: DrilldownRow, windows: EvidenceWindows): DrilldownRowRead => ({ item: addressedItem(row.item), links: row.links,
  questions: { ...row.questions, items: row.questions.items.map((question) => ({ question: question.question, evidence: evidenceRead(question.evidence, windows),
    statuses: { ...question.statuses, items: question.statuses.items.map(({ evidence: _evidence, ...status }) => status) },
    answers: question.answers, superseded_answers: question.superseded_answers })) } });

export interface GradeableItemRow { readonly item: AddressedItem; readonly links: Paged<LogicalLinkRead> }
export interface UnresolvedReferenceRead extends Omit<UnresolvedReference, "item"> { readonly item: AddressedItem }

// --------------------------------------------------------------- item state ---

/** One stored answer as a client reads it, marked current or replaced within its correction chain. */
export interface AnswerRead extends AnswerDetail { readonly is_current: boolean }
export function answerReads(details: readonly AnswerDetail[]): readonly AnswerRead[] {
  const current = new Set(selectCurrentAnswers(details).map((answer) => answer.observation_id));
  return details.map((answer) => ({ ...answer, is_current: current.has(answer.observation_id) }));
}

/** Whether a reviewer can answer this question now. Nothing but this question's own readiness decides it. */
export type HumanReadiness =
  | { readonly state: "ready" }
  | { readonly state: "not_ready"; readonly code: string; readonly detail: string }
  /** The question was pinned with no human evaluator, so no reviewer can answer it. */
  | { readonly state: "no_human_evaluator" };
export function humanReadiness(set: EvidenceSet, human_evaluator_ids: ReadonlySet<string>): HumanReadiness {
  if (set.readiness.state === "not_ready") return { state: "not_ready", ...set.readiness.reason };
  return set.pinned_evaluator_definition_ids.some((id) => human_evaluator_ids.has(id)) ? { state: "ready" } : { state: "no_human_evaluator" };
}

export interface QuestionStatusWindows extends EvidenceWindows { readonly machine: PageRequest; readonly attempts: PageRequest; readonly answers: PageRequest; readonly superseded_answers: PageRequest }
export const QUESTION_STATUS_WINDOWS = [...EVIDENCE_WINDOWS, "machine", "attempts", "answers", "superseded_answers"] as const;
/** One machine evaluator's distinct state for one question, with its real provider attempts. */
export interface MachineStatusRead<Measurement, Attempt> {
  readonly evaluator_definition_id: EvaluatorDefinitionId;
  readonly backend_kind: string;
  readonly model: string | null;
  readonly execution_id: string | null;
  readonly measurement: Measurement;
  readonly attempts: Paged<Attempt>;
}
export interface QuestionStatusRead<Measurement = JsonValue, Attempt = JsonValue> {
  readonly question: QuestionDefinition;
  readonly evidence: EvidenceRead;
  readonly human: HumanReadiness;
  readonly machine: Paged<MachineStatusRead<Measurement, Attempt>>;
  readonly answers: Paged<AnswerRead>;
  readonly superseded_answers: Paged<AnswerRead>;
}
export interface ItemStatusRead<Measurement = JsonValue, Attempt = JsonValue> {
  readonly item: AddressedItem;
  readonly is_grading_enabled: boolean;
  readonly links: Paged<LogicalLinkRead>;
  readonly questions: Paged<QuestionStatusRead<Measurement, Attempt>>;
}
