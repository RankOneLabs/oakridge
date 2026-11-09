import type { EvaluatorDefinitionId, ExecutionId, GradeObservationId, ItemOccurrenceId, QuestionId } from "../domain/identity";
import { pageOf, selectComposite, selectDrilldown, selectLineage, selectUnlinkedItems, selectUnresolvedReferences, type CompositeAnswer, type CompositeDrilldownKey,
  type CompositeEvaluator, type CompositeInputs, type CompositeRelation, type ContributionItem, type DrilldownPages, type DrilldownRow, type LogicalItemComposite,
  type LogicalItemLineage, type PageRequest, type Paged, type UnresolvedReference } from "../grading/composite";
import type { ExecutionStatus, ExecutionTerminalCause } from "../grading/execution";
import type { GradeAnswer } from "../grading/observation";
import type { CompositePath } from "../ports/producer-profile";
import { evidenceSetFromRow } from "./captured-evidence-store";
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
export function readEvidenceSetRecord(db: Database, tenant: TenantScope, evidence_set_id: string) {
  return withTenant(db, tenant, (trx) => trx.selectFrom("observation.evidence_set").selectAll()
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("evidence_set_id", "=", evidence_set_id).executeTakeFirst());
}

// ------------------------------------------------------------------- composite reads ---

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
  const answers = await trx.selectFrom("observation.grade_observation as g")
    .innerJoin("observation.evaluation_execution as x", (join) => join.onRef("x.producer", "=", "g.producer").onRef("x.namespace", "=", "g.namespace").onRef("x.execution_id", "=", "g.execution_id"))
    .select(["g.observation_id", "g.execution_id", "x.subject_occurrence_id", "x.evidence_set_id", "x.question_id", "x.question_version", "x.evaluator_definition_id", "g.reviewer_id",
      "g.answer_payload", "g.supersedes_observation_id", "g.confidence", "g.rationale", "g.comments", "g.recorded_at"])
    .where("g.producer", "=", producer).where("g.namespace", "=", namespace).where("x.run_id", "=", run_id).orderBy("g.recorded_at").orderBy("g.observation_id").execute();
  const questions = await trx.selectFrom("observation.question_definition").selectAll().where("producer", "=", producer).where("namespace", "=", namespace).execute();
  return { run_id, is_grading_enabled: await isRunGradingEnabled(trx, tenant, run_id), logical_items,
    revisions: revisions.map((row) => ({ ...row })),
    occurrences: occurrences.map(({ json_pointer, occurrence_id, ...row }) => ({ ...row, occurrence_id: occurrence_id as ItemOccurrenceId, item_path: json_pointer })),
    relations: relations.flatMap((row) => row.source_occurrence_id === null ? [] : [{ ...row, source_occurrence_id: row.source_occurrence_id as ItemOccurrenceId,
      target_occurrence_id: row.target_occurrence_id as ItemOccurrenceId | null, type: row.type as CompositeRelation["type"] }]),
    evidence_sets: evidence.map(evidenceSetFromRow),
    evaluators: evaluators.map((row) => ({ ...row, evaluator_definition_id: row.evaluator_definition_id as EvaluatorDefinitionId, kind: row.kind as CompositeEvaluator["kind"] })),
    executions: executions.map(({ subject_occurrence_id, ...row }) => ({ ...row, occurrence_id: subject_occurrence_id as ItemOccurrenceId, execution_id: row.execution_id as ExecutionId,
      evaluator_definition_id: row.evaluator_definition_id as EvaluatorDefinitionId, status: row.status as ExecutionStatus,
      terminal_cause: row.terminal_cause as ExecutionTerminalCause | null })),
    answers: answers.map((row): CompositeAnswer => ({ observation_id: row.observation_id as GradeObservationId, execution_id: row.execution_id as ExecutionId,
      occurrence_id: row.subject_occurrence_id as ItemOccurrenceId, evidence_set_id: row.evidence_set_id,
      question: { question_id: row.question_id as QuestionId, question_version: row.question_version },
      evaluator_definition_id: row.evaluator_definition_id as EvaluatorDefinitionId, reviewer_id: row.reviewer_id, answer: row.answer_payload as unknown as GradeAnswer,
      supersedes_observation_id: row.supersedes_observation_id as GradeObservationId | null, confidence: row.confidence, rationale: row.rationale, comments: row.comments,
      recorded_at: row.recorded_at })),
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
  return readRun(db, tenant, path, run_id, (inputs) => {
    const items = pageOf(inputs.logical_items, page);
    return { ...items, items: items.items.map((item) => selectComposite(inputs, path, item)) };
  });
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
export function listRunUnresolvedReferences(db: Database, tenant: TenantScope, path: CompositePath, run_id: string, page: PageRequest): Promise<Paged<UnresolvedReference>> {
  return readRun(db, tenant, path, run_id, (inputs) => selectUnresolvedReferences(inputs, path, page));
}
