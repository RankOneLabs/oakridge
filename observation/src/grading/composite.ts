/**
 * Unstored reads over one run's captured rows: how the answers measured for narrow items stand under
 * the logical items they were explicitly linked to. Every function here is pure, takes rows a store
 * read, and creates no record. A logical item is never answered directly; it collects its current
 * linked occurrences, stage by stage, and each count leads back to those raw items and answers.
 *
 *   revisions -> current per stream -> contributions -> linked to one logical item
 *     -> current answers per correction chain -> counts per stage -> drilldown to raw rows
 */
import { canonicalJson } from "canonical-json";
import { groupRows, indexCompositeInputs, subjectIndexKey, questionIndexKey, type CompositeIndexes } from "./composite-index";
import type { ArtifactRevisionId, EvaluatorDefinitionId, EvidenceSetId, ExecutionId, GradeObservationId, ItemOccurrenceId, LogicalItemId, RelationId, ReviewerId, RunId, UnitId } from "../domain/identity";
import type { JsonValue } from "../domain/primitives";
import type { CompositePath } from "../ports/producer-profile";
import type { RelationType } from "../projection/extractor";
import { logicalReference } from "../projection/relations";
import type { EvidenceSet } from "./evidence";
import { measurementState, type ExecutionStatus, type ExecutionTerminalCause, type MeasurementState } from "./execution";
import type { GradeAnswer } from "./observation";
import type { QuestionDefinition, QuestionKey } from "./question";

// ------------------------------------------------------------------- pages ---

export interface PageRequest { readonly limit: number; readonly offset: number }
/** One slice of a complete list: `total` is always the whole list's size, so nothing is hidden. */
export interface Paged<Item> extends PageRequest { readonly items: readonly Item[]; readonly total: number }
export const pageOf = <Item>(items: readonly Item[], page: PageRequest): Paged<Item> =>
  ({ items: items.slice(page.offset, page.offset + page.limit), total: items.length, ...page });

// --------------------------------------------------------------- what is read ---

export interface CompositeLogicalItem { readonly logical_item_id: LogicalItemId; readonly scope: string; readonly producer_local_id: string }
export interface CompositeRevision {
  readonly revision_id: ArtifactRevisionId;
  readonly unit_id: UnitId;
  readonly artifact_kind: string;
  readonly predecessor_id: ArtifactRevisionId | null;
  readonly recorded_at: Date;
  readonly captured_at: Date;
}
export interface CompositeOccurrence {
  readonly occurrence_id: ItemOccurrenceId;
  readonly revision_id: ArtifactRevisionId;
  readonly artifact_kind: string;
  readonly item_kind: string;
  readonly item_path: string;
  readonly logical_item_id: LogicalItemId | null;
  readonly selected_value: JsonValue;
}
export interface CompositeRelation {
  readonly relation_id: RelationId;
  readonly source_occurrence_id: ItemOccurrenceId;
  readonly target_occurrence_id: ItemOccurrenceId | null;
  readonly target_logical_item_id: LogicalItemId | null;
  readonly unresolved_target_ref: string | null;
  readonly type: RelationType;
  readonly asserted_by: string;
  readonly evidence_ref: string;
}
export interface CompositeEvaluator {
  readonly evaluator_definition_id: EvaluatorDefinitionId;
  readonly kind: "model" | "code" | "human";
  readonly backend_kind: string;
  readonly provider: string;
  readonly model: string | null;
}
export interface CompositeExecution {
  readonly task_id: LogicalItemId | null;
  readonly execution_id: ExecutionId;
  readonly occurrence_id: ItemOccurrenceId;
  readonly evidence_set_id: EvidenceSetId;
  readonly evaluator_definition_id: EvaluatorDefinitionId;
  readonly attempt_label: string;
  readonly status: ExecutionStatus;
  readonly terminal_cause: ExecutionTerminalCause | null;
  readonly error: string | null;
}
/** One stored answer with the measurement it belongs to, read through its execution. */
export interface CompositeAnswer {
  readonly task_id: LogicalItemId | null;
  readonly observation_id: GradeObservationId;
  readonly execution_id: ExecutionId;
  readonly occurrence_id: ItemOccurrenceId;
  readonly evidence_set_id: EvidenceSetId;
  readonly question: QuestionKey;
  readonly evaluator_definition_id: EvaluatorDefinitionId;
  readonly reviewer_id: ReviewerId | null;
  readonly answer: GradeAnswer;
  readonly supersedes_observation_id: GradeObservationId | null;
  readonly confidence: number | null;
  readonly rationale: string | null;
  readonly comments: string | null;
  readonly recorded_at: Date;
}
/** Everything one run holds that a composite reads, from one snapshot. */
export interface CompositeInputs {
  readonly run_id: RunId;
  readonly is_grading_enabled: boolean;
  readonly logical_items: readonly CompositeLogicalItem[];
  readonly revisions: readonly CompositeRevision[];
  readonly occurrences: readonly CompositeOccurrence[];
  readonly relations: readonly CompositeRelation[];
  readonly evidence_sets: readonly EvidenceSet[];
  readonly evaluators: readonly CompositeEvaluator[];
  readonly executions: readonly CompositeExecution[];
  readonly answers: readonly CompositeAnswer[];
  readonly questions: readonly QuestionDefinition[];
}

// ------------------------------------------------------------ current revisions ---

export interface RevisionStanding { readonly revision: CompositeRevision; readonly stage: string | null; readonly is_current: boolean }
const byRecording = (left: CompositeRevision, right: CompositeRevision): number =>
  left.recorded_at.getTime() - right.recorded_at.getTime() || left.captured_at.getTime() - right.captured_at.getTime()
  || (left.revision_id < right.revision_id ? -1 : left.revision_id > right.revision_id ? 1 : 0);

/**
 * Each unit's artifact is one stream with one current revision: the latest recorded that no revision
 * of the stream names as its predecessor. Streams are decided separately and before any link is
 * looked at, so one unit's newer revision never hides another unit's, and a newer revision holding
 * no links still replaces an older linked one.
 */
export function selectRevisionStandings(revisions: readonly CompositeRevision[], path: Pick<CompositePath, "stageOf">): ReadonlyMap<string, RevisionStanding> {
  const streams = new Map<string, CompositeRevision[]>();
  for (const revision of revisions) {
    const key = JSON.stringify([revision.unit_id, revision.artifact_kind]);
    streams.set(key, [...(streams.get(key) ?? []), revision]);
  }
  const standings = new Map<string, RevisionStanding>();
  for (const stream of streams.values()) {
    const ordered = [...stream].sort(byRecording);
    const replaced = new Set(stream.flatMap((revision) => revision.predecessor_id ? [revision.predecessor_id] : []));
    const heads = ordered.filter((revision) => !replaced.has(revision.revision_id));
    const current = (heads.at(-1) ?? ordered.at(-1))?.revision_id;
    for (const revision of ordered) standings.set(revision.revision_id, { revision, stage: path.stageOf(revision), is_current: revision.revision_id === current });
  }
  return standings;
}

// ---------------------------------------------------------------- contributions ---

/** One gradeable item of a stage's revision, and the edges it explicitly declared. */
export interface Contribution {
  readonly occurrence: CompositeOccurrence;
  readonly stage: string;
  readonly unit_id: UnitId;
  readonly is_current: boolean;
  readonly links: readonly CompositeRelation[];
}
interface ContributionRead {
  readonly inputs: CompositeInputs;
  readonly path: CompositePath;
  readonly standings: ReadonlyMap<string, RevisionStanding>;
  readonly relations: CompositeIndexes["relations"];
}
function contributionsFrom({ inputs, path, standings, relations }: ContributionRead): readonly Contribution[] {
  return inputs.occurrences.flatMap((occurrence) => {
    const standing = standings.get(occurrence.revision_id);
    if (!standing?.stage || !path.item_kinds.includes(occurrence.item_kind)) return [];
    return [{ occurrence, stage: standing.stage, unit_id: standing.revision.unit_id, is_current: standing.is_current,
      links: (relations.get(occurrence.occurrence_id) ?? []).filter((relation) => relation.type === path.relation_type) }];
  });
}
export function selectContributions(inputs: CompositeInputs, path: CompositePath): readonly Contribution[] {
  return contributionsFrom({ inputs, path, standings: selectRevisionStandings(inputs.revisions, path),
    relations: groupRows(inputs.relations, (relation) => relation.source_occurrence_id) });
}
/** One occurrence once, however many explicit paths lead from it to this logical item. */
export const selectLinkedContributions = (contributions: readonly Contribution[], logical_item_id: string): readonly Contribution[] =>
  contributions.filter((contribution) => contribution.links.some((link) => link.target_logical_item_id === logical_item_id));

// ---------------------------------------------------------------- current answers ---

/** A superseded answer stays in history; the end of each explicit correction chain is what stands. */
export function selectCurrentAnswers(answers: readonly CompositeAnswer[]): readonly CompositeAnswer[] {
  const replaced = new Set(answers.flatMap((answer) => answer.supersedes_observation_id ? [answer.supersedes_observation_id] : []));
  return answers.filter((answer) => !replaced.has(answer.observation_id));
}
export const selectSupersededAnswers = (answers: readonly CompositeAnswer[]): readonly CompositeAnswer[] => {
  const current = new Set(selectCurrentAnswers(answers).map((answer) => answer.observation_id));
  return answers.filter((answer) => !current.has(answer.observation_id));
};

export type GraderKey =
  | { readonly kind: "machine"; readonly evaluator_definition_id: EvaluatorDefinitionId; readonly backend_kind: string; readonly model: string | null }
  | { readonly kind: "human"; readonly evaluator_definition_id: EvaluatorDefinitionId; readonly reviewer_id: ReviewerId };
/** An actual answer as counted. A choice of "unclear" is `answered`; `abstain` and `unclear` here are the states that carry no value. */
export type AnswerKey =
  | { readonly state: "answered"; readonly value: JsonValue }
  | { readonly state: "abstain" | "unclear" };

const answerKey = (answer: GradeAnswer): AnswerKey => answer.state === "answered" ? { state: "answered", value: answer.value } : { state: answer.state };
const keyText = (value: unknown): string => {
  const encoded = canonicalJson(value);
  return encoded.ok ? encoded.value : JSON.stringify(value);
};
const questionKey = (question: QuestionKey): QuestionKey => ({ question_id: question.question_id, question_version: question.question_version });
const sameQuestion = (left: QuestionKey, right: QuestionKey): boolean =>
  left.question_id === right.question_id && left.question_version === right.question_version;

export function graderOf(answer: CompositeAnswer, evaluators: ReadonlyMap<string, CompositeEvaluator>): GraderKey {
  const evaluator = evaluators.get(answer.evaluator_definition_id);
  return answer.reviewer_id !== null ? { kind: "human", evaluator_definition_id: answer.evaluator_definition_id, reviewer_id: answer.reviewer_id }
    : { kind: "machine", evaluator_definition_id: answer.evaluator_definition_id, backend_kind: evaluator?.backend_kind ?? "", model: evaluator?.model ?? null };
}

/** A machine evaluator's status that is not an answer. A human with no answer yet owes nothing, so has none. */
export type ItemStatusKey =
  | { readonly state: "not_ready"; readonly code: string }
  | { readonly state: "grading_off" }
  | { readonly state: "awaiting_admission" }
  | { readonly state: "pending" }
  | { readonly state: "budget_deferred" }
  | { readonly state: "failed"; readonly terminal_cause: ExecutionTerminalCause | null };
const itemStatus = (state: MeasurementState): ItemStatusKey | null => {
  switch (state.state) {
    case "not_ready": return { state: "not_ready", code: state.code };
    case "failed": return { state: "failed", terminal_cause: state.terminal_cause };
    case "grading_off": case "awaiting_admission": case "pending": case "budget_deferred": return { state: state.state };
    case "answered": return null;
  }
};

export interface MeasurementRead {
  readonly task_id: LogicalItemId | null;
  readonly question: QuestionKey;
  readonly evidence: EvidenceSet;
  /** Null for a question's own not-ready status, which every evaluator of it shares. */
  readonly evaluator_definition_id: EvaluatorDefinitionId | null;
  readonly execution_id: ExecutionId | null;
  readonly status: ItemStatusKey;
  readonly detail: string | null;
}
const failureDetail = (state: MeasurementState): string | null => state.state === "failed" ? state.error : state.state === "not_ready" ? state.detail : null;

/** Every status an occurrence's pinned questions stand at. An unready question counts once; a ready
 * one once per pinned machine evaluator it has no answer from. */
function selectMeasurements(occurrence_id: ItemOccurrenceId, task_id: LogicalItemId | null, inputs: CompositeInputs, index: CompositeIndexes): readonly MeasurementRead[] {
  return (index.evidence.get(subjectIndexKey(occurrence_id, task_id)) ?? []).flatMap((evidence): readonly MeasurementRead[] => {
    const question = questionKey(evidence);
    if (evidence.readiness.state === "not_ready") {
      const state = measurementState({ readiness: evidence.readiness, is_grading_enabled: inputs.is_grading_enabled, execution: null, observation: null });
      const status = itemStatus(state);
      return status ? [{ task_id: evidence.task_id, question, evidence, evaluator_definition_id: null, execution_id: null, status, detail: failureDetail(state) }] : [];
    }
    return evidence.pinned_evaluator_definition_ids.filter((id) => index.machines.has(id)).flatMap((evaluator_definition_id) => {
      const execution = index.executions.get(evidence.evidence_set_id)?.get(evaluator_definition_id) ?? null;
      const answer = execution ? index.answers_by_execution.get(execution.execution_id) ?? null : null;
      const state = measurementState({ readiness: evidence.readiness, is_grading_enabled: inputs.is_grading_enabled,
        execution: execution ? { status: execution.status, terminal_cause: execution.terminal_cause, error: execution.error } : null,
        observation: answer ? { observation_id: answer.observation_id, answer: answer.answer } : null });
      const status = itemStatus(state);
      return status ? [{ task_id: evidence.task_id, question, evidence, evaluator_definition_id, execution_id: execution?.execution_id ?? null, status, detail: failureDetail(state) }] : [];
    });
  });
}

/** Each subject once, even when it has several pinned questions. */
function occurrenceMeasurements(occurrence_id: ItemOccurrenceId, inputs: CompositeInputs, index: CompositeIndexes): readonly MeasurementRead[] {
  const tasks = new Set(inputs.evidence_sets.filter((set) => set.subject_occurrence_id === occurrence_id).map((set) => set.task_id));
  return [...tasks].flatMap((task_id) => selectMeasurements(occurrence_id, task_id, inputs, index));
}

// ------------------------------------------------------------------- composites ---

/** What a count opens. `items` lists a stage's current contributions, `history` what they replaced. */
export type CompositeSelector =
  | { readonly kind: "items" }
  | { readonly kind: "history" }
  | { readonly kind: "answer"; readonly question: QuestionKey; readonly grader: GraderKey; readonly answer: AnswerKey }
  | { readonly kind: "status"; readonly question: QuestionKey; readonly evaluator_definition_id: EvaluatorDefinitionId | null; readonly status: ItemStatusKey }
  | { readonly kind: "disagreement"; readonly question: QuestionKey };
export interface CompositeDrilldownKey { readonly logical_item_id: LogicalItemId; readonly stage: string; readonly selector: CompositeSelector }

export interface AnswerCount { readonly question: QuestionKey; readonly grader: GraderKey; readonly answer: AnswerKey; readonly count: number; readonly drilldown: CompositeDrilldownKey }
export interface StatusCount { readonly question: QuestionKey; readonly evaluator_definition_id: EvaluatorDefinitionId | null; readonly status: ItemStatusKey; readonly count: number; readonly drilldown: CompositeDrilldownKey }
/** Differing current answers on the same occurrence and question. Different items answering differently is no disagreement. */
export interface DisagreementCount { readonly question: QuestionKey; readonly item_count: number; readonly drilldown: CompositeDrilldownKey }
export interface QuestionSummary extends QuestionKey { readonly item_kind: string; readonly question_text: string | null; readonly allowed_values: readonly JsonValue[] | null }
/** Distinct current items in each condition; one item can stand in several, per question and evaluator. */
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
  /** `is_final` comes from the stage alone: answers, links and approvals never decide it. */
  | { readonly state: "published"; readonly is_final: boolean; readonly unit_ids: readonly UnitId[] };
export interface StageComposite {
  readonly stage: string;
  readonly publication: StagePublication;
  /** `gap` means no current item here is linked: a coverage gap, never a pass or a zero. */
  readonly coverage: "linked" | "gap";
  readonly totals: StageTotals;
  readonly questions: readonly QuestionSummary[];
  readonly answers: readonly AnswerCount[];
  readonly statuses: readonly StatusCount[];
  readonly disagreements: readonly DisagreementCount[];
  readonly items: CompositeDrilldownKey;
  readonly history: CompositeDrilldownKey;
}
/** One logical item's stages side by side. There is deliberately no figure across them. */
export interface LogicalItemComposite {
  readonly run_id: RunId;
  readonly logical_item_id: LogicalItemId;
  readonly scope: string;
  readonly producer_local_id: string;
  readonly coverage: "linked" | "gap";
  readonly stages: readonly StageComposite[];
}

function selectPublication(stage: CompositePath["stages"][number], standings: readonly RevisionStanding[]): StagePublication {
  const unit_ids = [...new Set(standings.filter((standing) => standing.stage === stage.stage).map((standing) => standing.revision.unit_id))].sort();
  return unit_ids.length === 0 ? { state: "pending" } : { state: "published", is_final: stage.is_final_on_publication, unit_ids };
}

const countInto = <Value>(counts: Map<string, { readonly value: Value; count: number }>, key: string, value: Value): void => {
  const existing = counts.get(key);
  if (existing) existing.count += 1;
  else counts.set(key, { value, count: 1 });
};
const sortedEntries = <Value>(counts: ReadonlyMap<string, { readonly value: Value; readonly count: number }>): readonly { readonly value: Value; readonly count: number }[] =>
  [...counts.keys()].sort().map((key) => counts.get(key)!);

interface PreparedCompositeRead {
  readonly inputs: CompositeInputs;
  readonly path: CompositePath;
  readonly index: CompositeIndexes;
  readonly linked: ReadonlyMap<LogicalItemId, readonly Contribution[]>;
  readonly publications: ReadonlyMap<string, StagePublication>;
  readonly measurements: ReadonlyMap<string, readonly MeasurementRead[]>;
}
function prepareCompositeRead(inputs: CompositeInputs, path: CompositePath): PreparedCompositeRead {
  const index = indexCompositeInputs(inputs);
  const standings = selectRevisionStandings(inputs.revisions, path);
  const contributions = contributionsFrom({ inputs, path, standings, relations: index.relations });
  const linked = new Map<LogicalItemId, Contribution[]>();
  for (const contribution of contributions) {
    const targets = new Set(contribution.links.flatMap((link) => link.target_logical_item_id ? [link.target_logical_item_id] : []));
    for (const target of targets) {
      const group = linked.get(target);
      if (group) group.push(contribution);
      else linked.set(target, [contribution]);
    }
  }
  return { inputs, path, index, linked,
    publications: new Map(path.stages.map((stage) => [stage.stage, selectPublication(stage, [...standings.values()])])),
    measurements: new Map(inputs.evidence_sets.map((evidence) => [subjectIndexKey(evidence.subject_occurrence_id, evidence.task_id),
      selectMeasurements(evidence.subject_occurrence_id, evidence.task_id, inputs, index)])) };
}
function stageComposite(stage: CompositePath["stages"][number], logical_item_id: LogicalItemId, linked: readonly Contribution[], read: PreparedCompositeRead): StageComposite {
  const { index } = read;
  const key = (selector: CompositeSelector): CompositeDrilldownKey => ({ logical_item_id, stage: stage.stage, selector });
  const inStage = linked.filter((contribution) => contribution.stage === stage.stage);
  const current = inStage.filter((contribution) => contribution.is_current);
  const standing = current.flatMap(({ occurrence }) => index.current_answers.get(subjectIndexKey(occurrence.occurrence_id, logical_item_id)) ?? []);
  // Items, not rows: two uncorrected answers alike from one reviewer on one item open as that one item.
  const answerCounts = new Map<string, { readonly value: Omit<AnswerCount, "count" | "drilldown">; count: number }>();
  const answeredItems = new Set<string>();
  for (const answer of standing) {
    const value = { question: answer.question, grader: graderOf(answer, index.evaluators), answer: answerKey(answer.answer) };
    const key = keyText(value);
    const item = JSON.stringify([key, answer.occurrence_id]);
    if (answeredItems.has(item)) continue;
    answeredItems.add(item);
    countInto(answerCounts, key, value);
  }
  const statusCounts = new Map<string, { readonly value: Omit<StatusCount, "count" | "drilldown">; count: number }>();
  const inCondition = (states: readonly ItemStatusKey["state"][]) => new Set(current.filter((contribution) =>
    (read.measurements.get(subjectIndexKey(contribution.occurrence.occurrence_id, logical_item_id)) ?? []).some((measurement) => states.includes(measurement.status.state))).map((contribution) => contribution.occurrence.occurrence_id)).size;
  for (const contribution of current) for (const measurement of (read.measurements.get(subjectIndexKey(contribution.occurrence.occurrence_id, logical_item_id)) ?? [])) {
    const value = { question: measurement.question, evaluator_definition_id: measurement.evaluator_definition_id, status: measurement.status };
    countInto(statusCounts, keyText(value), value);
  }
  const disagreementCounts = new Map<string, { readonly value: QuestionKey; count: number }>();
  for (const contribution of current) {
    const answers = index.current_answers.get(subjectIndexKey(contribution.occurrence.occurrence_id, logical_item_id)) ?? [];
    for (const question of uniqueQuestions(answers.map((answer) => answer.question)))
      if (new Set(answers.filter((answer) => sameQuestion(answer.question, question)).map((answer) => keyText(answerKey(answer.answer)))).size > 1)
        countInto(disagreementCounts, keyText(question), question);
  }
  const pinned = uniqueQuestions(current.flatMap(({ occurrence }) => index.evidence.get(subjectIndexKey(occurrence.occurrence_id, logical_item_id)) ?? []).map(questionKey));
  const history = inStage.filter((contribution) => !contribution.is_current);
  return { stage: stage.stage, publication: read.publications.get(stage.stage)!, coverage: current.length > 0 ? "linked" : "gap",
    totals: { contributing_items: current.length, not_ready_items: inCondition(["not_ready"]), pending_items: inCondition(["pending", "awaiting_admission"]),
      failed_items: inCondition(["failed"]), budget_deferred_items: inCondition(["budget_deferred"]), grading_off_items: inCondition(["grading_off"]),
      superseded_items: history.length,
      superseded_answers: inStage.reduce((total, { occurrence }) => total + (index.superseded_answers.get(subjectIndexKey(occurrence.occurrence_id, logical_item_id))?.length ?? 0), 0) },
    questions: pinned.flatMap((question) => {
      const definition = index.questions.get(questionIndexKey(question));
      return definition ? [{ ...question, item_kind: definition.item_kind, question_text: definition.question_text, allowed_values: definition.allowed_values }] : [];
    }),
    answers: sortedEntries(answerCounts).map(({ value, count }) => ({ ...value, count, drilldown: key({ kind: "answer", ...value }) })),
    statuses: sortedEntries(statusCounts).map(({ value, count }) => ({ ...value, count, drilldown: key({ kind: "status", ...value }) })),
    disagreements: sortedEntries(disagreementCounts).map(({ value, count }) => ({ question: value, item_count: count, drilldown: key({ kind: "disagreement", question: value }) })),
    items: key({ kind: "items" }), history: key({ kind: "history" }) };
}
function uniqueQuestions(questions: readonly QuestionKey[]): readonly QuestionKey[] {
  return [...new Map(questions.map((question) => [keyText(question), question])).entries()].sort(([left], [right]) => left < right ? -1 : 1).map(([, question]) => question);
}

function compositeFromRead(read: PreparedCompositeRead, item: CompositeLogicalItem): LogicalItemComposite {
  const linked = read.linked.get(item.logical_item_id) ?? [];
  return { run_id: read.inputs.run_id, logical_item_id: item.logical_item_id, scope: item.scope, producer_local_id: item.producer_local_id,
    coverage: linked.some((contribution) => contribution.is_current) ? "linked" : "gap",
    stages: read.path.stages.map((stage) => stageComposite(stage, item.logical_item_id, linked, read)) };
}
export function selectComposite(inputs: CompositeInputs, path: CompositePath, item: CompositeLogicalItem): LogicalItemComposite {
  return compositeFromRead(prepareCompositeRead(inputs, path), item);
}
export interface CompositePageRequest { readonly inputs: CompositeInputs; readonly path: CompositePath; readonly page: PageRequest }
/** All tasks on a page share one set of lookups, contributions, revision standings and measurements. */
export function selectCompositePage({ inputs, path, page }: CompositePageRequest): Paged<LogicalItemComposite> {
  const items = pageOf(inputs.logical_items, page);
  const read = prepareCompositeRead(inputs, path);
  return { ...items, items: items.items.map((item) => compositeFromRead(read, item)) };
}

// -------------------------------------------------------------------- drilldown ---

export interface AnswerDetail extends CompositeAnswer { readonly grader: GraderKey }
/** One question of a drilled item: its frozen evidence and raw answers, each answer list complete by paging. */
export interface DrilldownQuestion {
  readonly task_id: LogicalItemId | null;
  readonly is_linked_context: boolean;
  readonly question: QuestionKey;
  readonly evidence: EvidenceSet;
  readonly statuses: Paged<MeasurementRead>;
  readonly answers: Paged<AnswerDetail>;
  readonly superseded_answers: Paged<AnswerDetail>;
}
export interface ContributionItem {
  readonly occurrence_id: ItemOccurrenceId;
  readonly revision_id: ArtifactRevisionId;
  readonly item_path: string;
  readonly artifact_kind: string;
  readonly item_kind: string;
  readonly selected_value: JsonValue;
  readonly stage: string;
  readonly unit_id: UnitId;
  readonly is_current: boolean;
}
export interface DrilldownRow {
  readonly item: ContributionItem;
  readonly links: Paged<CompositeRelation>;
  readonly questions: Paged<DrilldownQuestion>;
}
export const contributionItem = ({ occurrence, stage, unit_id, is_current }: Contribution): ContributionItem => ({ occurrence_id: occurrence.occurrence_id, revision_id: occurrence.revision_id,
  item_path: occurrence.item_path, artifact_kind: occurrence.artifact_kind, item_kind: occurrence.item_kind, selected_value: occurrence.selected_value, stage, unit_id, is_current });
/** By revision, then by path as a reader would count them: /x/2 before /x/10. */
export const orderedItems = (contributions: readonly Contribution[]): readonly Contribution[] => [...contributions].sort((left, right) =>
  left.occurrence.revision_id < right.occurrence.revision_id ? -1 : left.occurrence.revision_id > right.occurrence.revision_id ? 1
    : left.occurrence.item_path.localeCompare(right.occurrence.item_path, undefined, { numeric: true }));

/** Which of one occurrence's questions a selector opens, or none when it does not contribute to the count. */
function selectedQuestions(selector: CompositeSelector, occurrence_id: ItemOccurrenceId, inputs: CompositeInputs, evaluators: ReadonlyMap<string, CompositeEvaluator>, index: CompositeIndexes): readonly QuestionKey[] {
  const pinned = uniqueQuestions(inputs.evidence_sets.filter((evidence) => evidence.subject_occurrence_id === occurrence_id).map(questionKey));
  const current = selectCurrentAnswers(inputs.answers).filter((answer) => answer.occurrence_id === occurrence_id);
  switch (selector.kind) {
    case "items": return pinned;
    case "history": return pinned;
    case "answer": return current.some((answer) => sameQuestion(answer.question, selector.question)
      && keyText(graderOf(answer, evaluators)) === keyText(selector.grader) && keyText(answerKey(answer.answer)) === keyText(selector.answer)) ? [selector.question] : [];
    case "status": return occurrenceMeasurements(occurrence_id, inputs, index).some((measurement) => sameQuestion(measurement.question, selector.question)
      && measurement.evaluator_definition_id === selector.evaluator_definition_id && keyText(measurement.status) === keyText(selector.status)) ? [selector.question] : [];
    case "disagreement": return new Set(current.filter((answer) => sameQuestion(answer.question, selector.question)).map((answer) => keyText(answerKey(answer.answer)))).size > 1
      ? [selector.question] : [];
  }
}

/** Each list has its own window, so a reader can continue any one of them while holding the others still. */
export interface DrilldownPages {
  readonly rows: PageRequest;
  readonly questions: PageRequest;
  readonly links: PageRequest;
  readonly statuses: PageRequest;
  readonly answers: PageRequest;
  readonly superseded_answers: PageRequest;
}
/** The same window for every list, which is what a reader opening a drilldown first asks for. */
export const uniformDrilldownPages = (page: PageRequest): DrilldownPages =>
  ({ rows: page, questions: page, links: page, statuses: page, answers: page, superseded_answers: page });
/** The exact items behind a count, with their raw answers and evidence. Rows are chosen from the whole
 * qualifying population before the page is cut, so a count and its drilldown's `total` agree. */
export function selectDrilldown(inputs: CompositeInputs, path: CompositePath, key: CompositeDrilldownKey, pages: DrilldownPages): Paged<DrilldownRow> {
  const include_context = key.selector.kind === "items" || key.selector.kind === "history";
  const belongs = (task_id: LogicalItemId | null): boolean => task_id === key.logical_item_id || (include_context && task_id === null);
  inputs = { ...inputs, evidence_sets: inputs.evidence_sets.filter((set) => belongs(set.task_id)),
    executions: inputs.executions.filter((execution) => belongs(execution.task_id)), answers: inputs.answers.filter((answer) => belongs(answer.task_id)) };
  const evaluators = new Map(inputs.evaluators.map((evaluator) => [evaluator.evaluator_definition_id as string, evaluator]));
  const index = indexCompositeInputs(inputs);
  const linked = selectLinkedContributions(selectContributions(inputs, path), key.logical_item_id).filter((contribution) => contribution.stage === key.stage);
  const superseded = selectSupersededAnswers(inputs.answers);
  const detail = (answer: CompositeAnswer): AnswerDetail => ({ ...answer, grader: graderOf(answer, evaluators) });
  const eligible = key.selector.kind === "history"
    ? linked.filter((contribution) => !contribution.is_current || superseded.some((answer) => answer.occurrence_id === contribution.occurrence.occurrence_id))
    : linked.filter((contribution) => contribution.is_current);
  const rows = orderedItems(eligible).flatMap((contribution): readonly DrilldownRow[] => {
    const occurrence_id = contribution.occurrence.occurrence_id;
    const questions = selectedQuestions(key.selector, occurrence_id, inputs, evaluators, index);
    if (questions.length === 0 && key.selector.kind !== "items" && key.selector.kind !== "history") return [];
    const measurements = occurrenceMeasurements(occurrence_id, inputs, index);
    const answersOf = selectCurrentAnswers(inputs.answers).filter((answer) => answer.occurrence_id === occurrence_id);
    const opened = questions.flatMap((question): readonly DrilldownQuestion[] => {
      const evidence = inputs.evidence_sets.find((set) => set.subject_occurrence_id === occurrence_id && sameQuestion(set, question));
      return evidence ? [{ task_id: evidence.task_id, is_linked_context: evidence.task_id === null, question, evidence, statuses: pageOf(measurements.filter((measurement) => sameQuestion(measurement.question, question)), pages.statuses),
        answers: pageOf(answersOf.filter((answer) => sameQuestion(answer.question, question)).map(detail), pages.answers),
        superseded_answers: pageOf(superseded.filter((answer) => answer.occurrence_id === occurrence_id && sameQuestion(answer.question, question)).map(detail), pages.superseded_answers) }] : [];
    });
    return [{ item: contributionItem(contribution), links: pageOf(contribution.links, pages.links), questions: pageOf(opened, pages.questions) }];
  });
  return pageOf(rows, pages.rows);
}

// ---------------------------------------------------------------------- lineage ---

export type LineageEntry =
  /** The logical item's own occurrence in a defining revision. */
  | { readonly kind: "occurrence"; readonly artifact_kind: string; readonly item_kind: string; readonly revision_id: ArtifactRevisionId; readonly item_path: string; readonly occurrence_id: ItemOccurrenceId; readonly unit_id: UnitId | null; readonly is_current: boolean }
  /** An edge such an occurrence declared; `unresolved_target_ref` keeps a target not captured visible. */
  | { readonly kind: "edge"; readonly relation: CompositeRelation; readonly revision_id: ArtifactRevisionId; readonly item_path: string }
  /** An item linked to it, current or superseded, with the explicit edge that links them. */
  | { readonly kind: "contribution"; readonly item: ContributionItem; readonly relation_id: RelationId; readonly evidence_ref: string; readonly asserted_by: string }
  /** An item that named this logical item before any such item was captured. */
  | { readonly kind: "unresolved"; readonly item: ContributionItem; readonly relation_id: RelationId; readonly unresolved_target_ref: string; readonly evidence_ref: string };
export interface LogicalItemLineage extends Paged<LineageEntry> {
  readonly run_id: RunId;
  readonly scope: string;
  readonly producer_local_id: string;
  /** False when items name this id but the run has captured no logical item for it. */
  readonly is_captured: boolean;
}

/** Definitions in recording order, then each stage's linked items in the profile's order, then what is still unresolved. */
export function selectLineage(inputs: CompositeInputs, path: CompositePath, producer_local_id: string, page: PageRequest): LogicalItemLineage {
  const item = inputs.logical_items.find((candidate) => candidate.scope === path.logical_scope && candidate.producer_local_id === producer_local_id) ?? null;
  const standings = selectRevisionStandings(inputs.revisions, path);
  const stream = (revision_id: string) => standings.get(revision_id);
  const recordedAt = (revision_id: string) => stream(revision_id)?.revision;
  const own = item === null ? [] : inputs.occurrences.filter((occurrence) => occurrence.logical_item_id === item.logical_item_id).sort((left, right) => {
    const [a, b] = [recordedAt(left.revision_id), recordedAt(right.revision_id)];
    return (a && b ? byRecording(a, b) : 0) || (left.item_path < right.item_path ? -1 : 1);
  });
  const definitions = own.flatMap((occurrence): readonly LineageEntry[] => [
    { kind: "occurrence", artifact_kind: occurrence.artifact_kind, item_kind: occurrence.item_kind, revision_id: occurrence.revision_id, item_path: occurrence.item_path,
      occurrence_id: occurrence.occurrence_id, unit_id: stream(occurrence.revision_id)?.revision.unit_id ?? null, is_current: stream(occurrence.revision_id)?.is_current ?? false },
    ...inputs.relations.filter((relation) => relation.source_occurrence_id === occurrence.occurrence_id)
      .map((relation): LineageEntry => ({ kind: "edge", relation, revision_id: occurrence.revision_id, item_path: occurrence.item_path })),
  ]);
  const contributions = selectContributions(inputs, path);
  const stageOrder = new Map(path.stages.map((stage, index) => [stage.stage, index]));
  const inStageOrder = (entries: readonly Contribution[]): readonly Contribution[] => [...orderedItems(entries)].sort((left, right) => (stageOrder.get(left.stage) ?? 0) - (stageOrder.get(right.stage) ?? 0));
  const linked = item === null ? [] : inStageOrder(selectLinkedContributions(contributions, item.logical_item_id)).flatMap((contribution): readonly LineageEntry[] =>
    contribution.links.filter((link) => link.target_logical_item_id === item.logical_item_id).map((link): LineageEntry => ({ kind: "contribution", item: contributionItem(contribution),
      relation_id: link.relation_id, evidence_ref: link.evidence_ref, asserted_by: link.asserted_by })));
  const reference = logicalReference(path.logical_scope, producer_local_id);
  const unresolved = inStageOrder(contributions.filter((contribution) => contribution.links.some((link) => link.unresolved_target_ref === reference))).flatMap((contribution): readonly LineageEntry[] =>
    contribution.links.filter((link) => link.unresolved_target_ref === reference).map((link): LineageEntry => ({ kind: "unresolved", item: contributionItem(contribution),
      relation_id: link.relation_id, unresolved_target_ref: reference, evidence_ref: link.evidence_ref })));
  return { ...pageOf([...definitions, ...linked, ...unresolved], page), run_id: inputs.run_id, scope: path.logical_scope, producer_local_id, is_captured: item !== null };
}

// ---------------------------------------------------- items outside any tracked task ---

/** A gradeable item linked to nothing is valid and stays readable with its answers. */
export const selectUnlinkedItems = (inputs: CompositeInputs, path: CompositePath, page: PageRequest): Paged<ContributionItem> =>
  pageOf(orderedItems(selectContributions(inputs, path).filter((contribution) => contribution.links.length === 0)).map(contributionItem), page);

export interface UnresolvedReference { readonly item: ContributionItem; readonly relation_id: RelationId; readonly unresolved_target_ref: string; readonly evidence_ref: string }
/** Every edge that names a target the run has not captured, and the item that named it. */
export const selectUnresolvedReferences = (inputs: CompositeInputs, path: CompositePath, page: PageRequest): Paged<UnresolvedReference> =>
  pageOf(orderedItems(selectContributions(inputs, path)).flatMap((contribution) => contribution.links.flatMap((link) => link.unresolved_target_ref === null ? []
    : [{ item: contributionItem(contribution), relation_id: link.relation_id, unresolved_target_ref: link.unresolved_target_ref, evidence_ref: link.evidence_ref }])), page);
