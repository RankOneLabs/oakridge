import type { ArtifactRevisionId, EvaluatorDefinitionId, EvidenceSetId, ExecutionId, GradeObservationId, ItemOccurrenceId, LogicalItemId, QuestionId, RelationId, ReviewerId, RunId, UnitId } from "../domain/identity";
import { contributionItem, graderOf, orderedItems, pageOf, selectComposite, selectCompositePage, selectContributions, selectDrilldown, selectLineage, selectRevisionStandings, selectUnlinkedItems, selectUnresolvedReferences, type AnswerDetail, type CompositeAnswer, type CompositeDrilldownKey,
  type CompositeEvaluator, type CompositeInputs, type CompositeLogicalItem, type CompositeRelation, type CompositeRevision, type ContributionItem, type DrilldownPages, type DrilldownRow, type LogicalItemComposite,
  type LogicalItemLineage, type PageRequest, type Paged, type UnresolvedReference } from "../grading/composite";
import type { QuestionKey } from "../grading/question";
import { addressedItem, answerReads, evidenceRead, humanReadiness, logicalLinks, type AddressedItem, type AnswerRead, type EvidenceRead, type EvidenceWindows, type GradeableItemRow, type ItemStatusRead,
  type MachineStatusRead, type QuestionStatusRead, type QuestionStatusWindows, type LogicalLinkRead, type UnresolvedReferenceRead } from "../grading/item-reads";
import type { ExecutionStatus, ExecutionTerminalCause, MeasurementState } from "../grading/execution";
import type { GradeAnswer } from "../grading/observation";
import type { CompositePath } from "../ports/producer-profile";
import { evidenceSetFromRow, readOccurrenceEvidence } from "./captured-evidence-store";
import { readItemMeasurementsIn, type AttemptRead } from "./execution-store";
import { withTenant, withTenantSnapshot, type Database, type DatabaseTransaction, type TenantScope } from "./database";
import { isRunGradingEnabled } from "./run-capture-store";
import { questionFromRow } from "./grading-store";

/** Immutable admission records, read under the same tenant boundary as executions. */
export interface QuestionRecordKey { readonly question_id: string; readonly question_version: string }
export function readQuestionRecord(db: Database, tenant: TenantScope, key: QuestionRecordKey) {
  return withTenant(db, tenant, (trx) => trx.selectFrom("observation.question_definition").selectAll()
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("question_id", "=", key.question_id).where("question_version", "=", key.question_version)
    .executeTakeFirst());
}
/** One frozen evidence set by id, with its references and pinned evaluators each read one window at a time. */
export async function readEvidenceSet(db: Database, tenant: TenantScope, evidence_set_id: string, windows: EvidenceWindows): Promise<EvidenceRead | null> {
  const row = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evidence_set").selectAll()
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("evidence_set_id", "=", evidence_set_id).executeTakeFirst());
  return row ? evidenceRead(evidenceSetFromRow(row), windows) : null;
}

// ------------------------------------------------------------------- composite reads ---

/** Answers with their measurements, read through their executions, in recording order. */
async function readAnswerRows(trx: DatabaseTransaction, tenant: TenantScope, within: { readonly run_id: string } | { readonly occurrence_id: string }): Promise<readonly CompositeAnswer[]> {
  const { producer, namespace } = tenant;
  const scoped = trx.selectFrom("observation.grade_observation as g")
    .innerJoin("observation.evaluation_execution as x", (join) => join.onRef("x.producer", "=", "g.producer").onRef("x.namespace", "=", "g.namespace").onRef("x.execution_id", "=", "g.execution_id"))
    .select(["g.observation_id", "g.execution_id", "x.subject_occurrence_id", "x.evidence_set_id", "x.question_id", "x.question_version", "x.evaluator_definition_id", "g.reviewer_id",
      "g.answer_payload", "g.supersedes_observation_id", "g.confidence", "g.rationale", "g.comments", "g.recorded_at"])
    .where("g.producer", "=", producer).where("g.namespace", "=", namespace);
  const rows = await ("run_id" in within ? scoped.where("x.run_id", "=", within.run_id) : scoped.where("x.subject_occurrence_id", "=", within.occurrence_id))
    .orderBy("g.recorded_at").orderBy("g.observation_id").execute();
  return rows.map((row): CompositeAnswer => ({ observation_id: row.observation_id as GradeObservationId, execution_id: row.execution_id as ExecutionId,
    occurrence_id: row.subject_occurrence_id as ItemOccurrenceId, evidence_set_id: row.evidence_set_id as EvidenceSetId,
    question: { question_id: row.question_id as QuestionId, question_version: row.question_version },
    evaluator_definition_id: row.evaluator_definition_id as EvaluatorDefinitionId, reviewer_id: row.reviewer_id as ReviewerId | null, answer: row.answer_payload as unknown as GradeAnswer,
    supersedes_observation_id: row.supersedes_observation_id as GradeObservationId | null, confidence: row.confidence, rationale: row.rationale, comments: row.comments,
    recorded_at: row.recorded_at }));
}

// Stored rows carry plain text; these name each id as the identity it is, at the one place rows are read.
interface RevisionRow { readonly revision_id: string; readonly unit_id: string; readonly artifact_kind: string; readonly predecessor_id: string | null; readonly recorded_at: Date; readonly captured_at: Date }
const revisionFromRow = (row: RevisionRow): CompositeRevision => ({ ...row, revision_id: row.revision_id as ArtifactRevisionId, unit_id: row.unit_id as UnitId,
  predecessor_id: row.predecessor_id as ArtifactRevisionId | null });
interface LogicalItemRow { readonly logical_item_id: string; readonly scope: string; readonly producer_local_id: string }
const logicalItemFromRow = (row: LogicalItemRow): CompositeLogicalItem => ({ ...row, logical_item_id: row.logical_item_id as LogicalItemId });
interface RelationRow { readonly relation_id: string; readonly target_occurrence_id: string | null; readonly target_logical_item_id: string | null; readonly unresolved_target_ref: string | null;
  readonly type: string; readonly asserted_by: string; readonly evidence_ref: string }
const relationFromRow = (source_occurrence_id: ItemOccurrenceId, row: RelationRow): CompositeRelation => ({ ...row, relation_id: row.relation_id as RelationId, source_occurrence_id,
  target_occurrence_id: row.target_occurrence_id as ItemOccurrenceId | null, target_logical_item_id: row.target_logical_item_id as LogicalItemId | null, type: row.type as CompositeRelation["type"] });

/** Every row of one run a composite reads, from one snapshot, so a count and its drilldown never mix commits. */
async function readCompositeInputs(trx: DatabaseTransaction, tenant: TenantScope, path: CompositePath, run_id: string): Promise<CompositeInputs> {
  const { producer, namespace } = tenant;
  const logical_items = await trx.selectFrom("observation.logical_item").select(["logical_item_id", "scope", "producer_local_id"]).where("producer", "=", producer)
    .where("namespace", "=", namespace).where("run_id", "=", run_id).where("scope", "=", path.logical_scope).orderBy("producer_local_id").execute();
  const revisions = await trx.selectFrom("observation.source_revision").select(["revision_id", "unit_id", "artifact_kind", "predecessor_id", "recorded_at", "captured_at"])
    .where("producer", "=", producer).where("namespace", "=", namespace).where("run_id", "=", run_id).execute();
  const occurrences = await trx.selectFrom("observation.item_occurrence")
    .select(["occurrence_id", "revision_id", "artifact_kind", "item_kind", "json_pointer", "logical_item_id", "selected_value"])
    .where("producer", "=", producer).where("namespace", "=", namespace).where("run_id", "=", run_id).execute();
  const ids = occurrences.map((occurrence) => occurrence.occurrence_id);
  const relations = ids.length === 0 ? [] : await trx.selectFrom("observation.item_relation")
    .select(["relation_id", "source_occurrence_id", "target_occurrence_id", "target_logical_item_id", "unresolved_target_ref", "type", "asserted_by", "evidence_ref"])
    .where("producer", "=", producer).where("namespace", "=", namespace).where("source_occurrence_id", "in", ids).orderBy("relation_id").execute();
  const evidence = ids.length === 0 ? [] : await trx.selectFrom("observation.evidence_set").selectAll().where("producer", "=", producer).where("namespace", "=", namespace)
    .where("subject_occurrence_id", "in", ids).orderBy("question_id").orderBy("question_version").execute();
  const evaluators = await trx.selectFrom("observation.evaluator_definition").select(["evaluator_definition_id", "kind", "backend_kind", "provider", "model"])
    .where("producer", "=", producer).where("namespace", "=", namespace).execute();
  const executions = await trx.selectFrom("observation.evaluation_execution")
    .select(["execution_id", "subject_occurrence_id", "evidence_set_id", "evaluator_definition_id", "attempt_label", "status", "terminal_cause", "error"])
    .where("producer", "=", producer).where("namespace", "=", namespace).where("run_id", "=", run_id).execute();
  const answers = await readAnswerRows(trx, tenant, { run_id });
  const questions = await trx.selectFrom("observation.question_definition").selectAll().where("producer", "=", producer).where("namespace", "=", namespace).execute();
  return { run_id: run_id as RunId, is_grading_enabled: await isRunGradingEnabled(trx, tenant, run_id), logical_items: logical_items.map(logicalItemFromRow),
    revisions: revisions.map(revisionFromRow),
    occurrences: occurrences.map(({ json_pointer, occurrence_id, revision_id, logical_item_id, ...row }) => ({ ...row, occurrence_id: occurrence_id as ItemOccurrenceId,
      revision_id: revision_id as ArtifactRevisionId, logical_item_id: logical_item_id as LogicalItemId | null, item_path: json_pointer })),
    relations: relations.flatMap((row) => row.source_occurrence_id === null ? [] : [relationFromRow(row.source_occurrence_id as ItemOccurrenceId, row)]),
    evidence_sets: evidence.map(evidenceSetFromRow),
    evaluators: evaluators.map((row) => ({ ...row, evaluator_definition_id: row.evaluator_definition_id as EvaluatorDefinitionId, kind: row.kind as CompositeEvaluator["kind"] })),
    executions: executions.map(({ subject_occurrence_id, ...row }) => ({ ...row, occurrence_id: subject_occurrence_id as ItemOccurrenceId, execution_id: row.execution_id as ExecutionId,
      evidence_set_id: row.evidence_set_id as EvidenceSetId,
      evaluator_definition_id: row.evaluator_definition_id as EvaluatorDefinitionId, status: row.status as ExecutionStatus,
      terminal_cause: row.terminal_cause as ExecutionTerminalCause | null })),
    answers,
    questions: questions.map(questionFromRow) };
}
const readRun = <Value>(db: Database, tenant: TenantScope, path: CompositePath, run_id: string, read: (inputs: CompositeInputs) => Value): Promise<Value> =>
  withTenantSnapshot(db, tenant, async (trx) => read(await readCompositeInputs(trx, tenant, path, run_id)));

/** One tracked logical item's composite, by its producer id within a run; null when the run has none. */
export function readLogicalItemComposite(db: Database, tenant: TenantScope, path: CompositePath, run_id: string, producer_local_id: string): Promise<LogicalItemComposite | null> {
  return readRun(db, tenant, path, run_id, (inputs) => {
    const item = inputs.logical_items.find((candidate) => candidate.producer_local_id === producer_local_id);
    return item ? selectComposite(inputs, path, item) : null;
  });
}
/** Every tracked logical item of a run, in id order. An item with no current link is listed, as a gap. */
export function listRunComposites(db: Database, tenant: TenantScope, path: CompositePath, run_id: string, page: PageRequest): Promise<Paged<LogicalItemComposite>> {
  return readRun(db, tenant, path, run_id, (inputs) => selectCompositePage({ inputs, path, page }));
}
/** The exact items, raw answers and frozen evidence behind one count. Needs only the read credential. */
export function readCompositeDrilldown(db: Database, tenant: TenantScope, path: CompositePath, run_id: string, key: CompositeDrilldownKey, pages: DrilldownPages): Promise<Paged<DrilldownRow>> {
  return readRun(db, tenant, path, run_id, (inputs) => selectDrilldown(inputs, path, key, pages));
}
export function readLogicalItemLineage(db: Database, tenant: TenantScope, path: CompositePath, run_id: string, producer_local_id: string, page: PageRequest): Promise<LogicalItemLineage> {
  return readRun(db, tenant, path, run_id, (inputs) => selectLineage(inputs, path, producer_local_id, page));
}
/** Items linked to nothing, which stay as gradeable and inspectable as any other. */
export function listRunUnlinkedItems(db: Database, tenant: TenantScope, path: CompositePath, run_id: string, page: PageRequest): Promise<Paged<ContributionItem>> {
  return readRun(db, tenant, path, run_id, (inputs) => selectUnlinkedItems(inputs, path, page));
}
/** The same list, each item carrying the address a client opens it by. */
export async function listRunUnlinkedAddressed(db: Database, tenant: TenantScope, path: CompositePath, run_id: string, page: PageRequest): Promise<Paged<AddressedItem>> {
  const items = await listRunUnlinkedItems(db, tenant, path, run_id, page);
  return { ...items, items: items.items.map((item) => addressedItem(item)) };
}
export async function listRunUnresolvedAddressed(db: Database, tenant: TenantScope, path: CompositePath, run_id: string, page: PageRequest): Promise<Paged<UnresolvedReferenceRead>> {
  const references = await listRunUnresolvedReferences(db, tenant, path, run_id, page);
  return { ...references, items: references.items.map((reference) => ({ ...reference, item: addressedItem(reference.item) })) };
}
export interface GradeableItemsQuery { readonly stage: string | null; readonly is_current_only: boolean; readonly page: PageRequest; readonly links: PageRequest }
/** Gradeable items by stage with their explicit links, unlinked ones included. Older revisions stay reachable with `is_current_only` false. */
export function listRunGradeableItems(db: Database, tenant: TenantScope, path: CompositePath, run_id: string, query: GradeableItemsQuery): Promise<Paged<GradeableItemRow>> {
  return readRun(db, tenant, path, run_id, (inputs) => {
    const stageOrder = new Map(path.stages.map((stage, index) => [stage.stage, index]));
    const chosen = selectContributions(inputs, path).filter((contribution) => (query.stage === null || contribution.stage === query.stage) && (!query.is_current_only || contribution.is_current));
    const ordered = [...orderedItems(chosen)].sort((left, right) => (stageOrder.get(left.stage) ?? 0) - (stageOrder.get(right.stage) ?? 0));
    const page = pageOf(ordered, query.page);
    return { ...page, items: page.items.map((contribution): GradeableItemRow => ({ item: addressedItem(contributionItem(contribution)),
      links: pageOf(logicalLinks(contribution.links, inputs.logical_items), query.links) })) };
  });
}
export function listRunUnresolvedReferences(db: Database, tenant: TenantScope, path: CompositePath, run_id: string, page: PageRequest): Promise<Paged<UnresolvedReference>> {
  return readRun(db, tenant, path, run_id, (inputs) => selectUnresolvedReferences(inputs, path, page));
}

// ------------------------------------------------------------------- item reads ---

interface ItemRowContext { readonly standing_stage: string | null; readonly item: ContributionItem; readonly links: readonly LogicalLinkRead[] }
async function readItemContext(trx: DatabaseTransaction, tenant: TenantScope, path: CompositePath, occurrence_id: string): Promise<ItemRowContext | null> {
  const { producer, namespace } = tenant;
  const occurrence = await trx.selectFrom("observation.item_occurrence").selectAll().where("producer", "=", producer).where("namespace", "=", namespace)
    .where("occurrence_id", "=", occurrence_id).executeTakeFirst();
  if (!occurrence) return null;
  const revision = await trx.selectFrom("observation.source_revision").select(["revision_id", "unit_id", "artifact_kind", "predecessor_id", "recorded_at", "captured_at"])
    .where("producer", "=", producer).where("namespace", "=", namespace).where("revision_id", "=", occurrence.revision_id).executeTakeFirstOrThrow();
  const stream = await trx.selectFrom("observation.source_revision").select(["revision_id", "unit_id", "artifact_kind", "predecessor_id", "recorded_at", "captured_at"])
    .where("producer", "=", producer).where("namespace", "=", namespace).where("run_id", "=", occurrence.run_id).where("unit_id", "=", revision.unit_id)
    .where("artifact_kind", "=", revision.artifact_kind).execute();
  const standing = selectRevisionStandings(stream.map(revisionFromRow), path).get(revision.revision_id as ArtifactRevisionId);
  const relations = await trx.selectFrom("observation.item_relation").select(["relation_id", "source_occurrence_id", "target_occurrence_id", "target_logical_item_id", "unresolved_target_ref", "type", "asserted_by", "evidence_ref"])
    .where("producer", "=", producer).where("namespace", "=", namespace).where("source_occurrence_id", "=", occurrence_id).where("type", "=", path.relation_type).orderBy("relation_id").execute();
  const targets = relations.flatMap((relation) => relation.target_logical_item_id ? [relation.target_logical_item_id] : []);
  const logical = targets.length === 0 ? [] : await trx.selectFrom("observation.logical_item").select(["logical_item_id", "scope", "producer_local_id"]).where("producer", "=", producer)
    .where("namespace", "=", namespace).where("logical_item_id", "in", targets).execute();
  const links = logicalLinks(relations.map((row) => relationFromRow(occurrence_id as ItemOccurrenceId, row)), logical.map(logicalItemFromRow));
  return { standing_stage: standing?.stage ?? null, links, item: { occurrence_id: occurrence_id as ItemOccurrenceId, revision_id: occurrence.revision_id as ArtifactRevisionId, item_path: occurrence.json_pointer,
    artifact_kind: occurrence.artifact_kind, item_kind: occurrence.item_kind, selected_value: occurrence.selected_value, stage: standing?.stage ?? "", unit_id: revision.unit_id as UnitId, is_current: standing?.is_current ?? false } };
}

export interface ItemAddressInRun { readonly run_id: string; readonly source_revision_id: string; readonly item_path: string }
/** The exact occurrence at one revision and path inside one run, with nothing else required of it. */
export function readItemAt(db: Database, tenant: TenantScope, path: CompositePath, address: ItemAddressInRun): Promise<AddressedItem | null> {
  return withTenantSnapshot(db, tenant, async (trx) => {
    const row = await trx.selectFrom("observation.item_occurrence").select("occurrence_id").where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("run_id", "=", address.run_id).where("revision_id", "=", address.source_revision_id).where("json_pointer", "=", address.item_path).executeTakeFirst();
    if (!row) return null;
    const context = await readItemContext(trx, tenant, path, row.occurrence_id);
    return context ? addressedItem(context.item) : null;
  });
}

export async function readItemEvidence(db: Database, tenant: TenantScope, occurrence_id: string, page: PageRequest, windows: EvidenceWindows): Promise<Paged<EvidenceRead> | null> {
  const known = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.item_occurrence").select("occurrence_id").where("producer", "=", tenant.producer)
    .where("namespace", "=", tenant.namespace).where("occurrence_id", "=", occurrence_id).executeTakeFirst());
  if (!known) return null;
  const sets = pageOf(await readOccurrenceEvidence(db, tenant, occurrence_id as ItemOccurrenceId), page);
  return { ...sets, items: sets.items.map((set) => evidenceRead(set, windows)) };
}

export interface ItemStatusWindows extends QuestionStatusWindows { readonly questions: PageRequest; readonly links: PageRequest }
/** An item's status as served: each machine evaluator's measurement state and real provider attempts. */
export type ItemStatusResponse = ItemStatusRead<MeasurementState, AttemptRead>;
export type QuestionStatusResponse = QuestionStatusRead<MeasurementState, AttemptRead>;
export type MachineStatusResponse = MachineStatusRead<MeasurementState, AttemptRead>;
export function readItemStatus(db: Database, tenant: TenantScope, path: CompositePath, occurrence_id: string, windows: ItemStatusWindows): Promise<ItemStatusResponse | null> {
  return withTenantSnapshot(db, tenant, async (trx) => {
    const context = await readItemContext(trx, tenant, path, occurrence_id);
    const measurements = context ? await readItemMeasurementsIn(trx, tenant, occurrence_id) : null;
    if (!context || !measurements) return null;
    const { producer, namespace } = tenant;
    const evaluators = await trx.selectFrom("observation.evaluator_definition").select(["evaluator_definition_id", "kind", "backend_kind", "provider", "model"]).where("producer", "=", producer).where("namespace", "=", namespace).execute();
    const byId = new Map(evaluators.map((row) => [row.evaluator_definition_id, { ...row, evaluator_definition_id: row.evaluator_definition_id as EvaluatorDefinitionId, kind: row.kind as CompositeEvaluator["kind"] }]));
    const human_ids = new Set(evaluators.filter((row) => row.kind === "human").map((row) => row.evaluator_definition_id));
    const rows = await readAnswerRows(trx, tenant, { occurrence_id });
    const reads = answerReads(rows.map((answer): AnswerDetail => ({ ...answer, grader: graderOf(answer, byId) })));
    const definitions = (await trx.selectFrom("observation.question_definition").selectAll().where("producer", "=", producer).where("namespace", "=", namespace).execute()).map(questionFromRow);
    const questions = pageOf(measurements.questions, windows.questions);
    return { item: addressedItem(context.item), is_grading_enabled: measurements.is_grading_enabled, links: pageOf(context.links, windows.links),
      questions: { ...questions, items: questions.items.map((question): QuestionStatusResponse => {
        const of = reads.filter((answer) => answer.evidence_set_id === question.evidence.evidence_set_id);
        const definition = definitions.find((candidate) => candidate.question_id === question.evidence.question_id && candidate.question_version === question.evidence.question_version);
        if (!definition) throw new Error(`question ${question.evidence.question_id}@${question.evidence.question_version} is pinned but not defined`);
        const machine = pageOf(question.machine, windows.machine);
        return { question: definition, evidence: evidenceRead(question.evidence, windows), human: humanReadiness(question.evidence, human_ids),
          machine: { ...machine, items: machine.items.map((entry) => ({ ...entry, attempts: pageOf(entry.attempts, windows.attempts) })) },
          answers: pageOf(of.filter((answer) => answer.is_current), windows.answers), superseded_answers: pageOf(of.filter((answer) => !answer.is_current), windows.superseded_answers) };
      }) } };
  });
}

export interface ItemAnswersQuery { readonly page: PageRequest; readonly reviewer_id: string | null; readonly question: QuestionKey | null }
export function readItemAnswers(db: Database, tenant: TenantScope, occurrence_id: string, query: ItemAnswersQuery): Promise<Paged<AnswerRead> | null> {
  return withTenantSnapshot(db, tenant, async (trx) => {
    const known = await trx.selectFrom("observation.item_occurrence").select("occurrence_id").where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("occurrence_id", "=", occurrence_id).executeTakeFirst();
    if (!known) return null;
    const evaluators = await trx.selectFrom("observation.evaluator_definition").select(["evaluator_definition_id", "kind", "backend_kind", "provider", "model"]).where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace).execute();
    const byId = new Map(evaluators.map((row) => [row.evaluator_definition_id, { ...row, evaluator_definition_id: row.evaluator_definition_id as EvaluatorDefinitionId, kind: row.kind as CompositeEvaluator["kind"] }]));
    const reads = answerReads((await readAnswerRows(trx, tenant, { occurrence_id })).map((answer): AnswerDetail => ({ ...answer, grader: graderOf(answer, byId) })));
    return pageOf(reads.filter((answer) => (query.reviewer_id === null || answer.reviewer_id === query.reviewer_id)
      && (query.question === null || (answer.question.question_id === query.question.question_id && answer.question.question_version === query.question.question_version))), query.page);
  });
}
