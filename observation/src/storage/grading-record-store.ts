import type { ItemOccurrenceId, GradeObservationId, QuestionId } from "../domain/identity";
import type { GradeAnswer } from "../grading/observation";
import type { GradingSupportRow } from "../grading/eligibility";
import { deriveCriterionComposite, type CriterionComposite, type CompositeItem, type CompositeJudgment } from "../grading/decision-policy";
import { readGradingSupport } from "./eligibility-store";
import { withTenant, type Database, type TenantScope } from "./database";

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

/** The composite is derived on read; no job, provider, coverage counter or grade is written. */
export async function readCriterionComposite(db: Database, tenant: TenantScope, selection: CriterionCompositeSelection)
  : Promise<CriterionComposite | null> {
  const rows = await withTenant(db, tenant, async (trx) => {
    const criterion = await trx.selectFrom("observation.item_occurrence").selectAll()
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("occurrence_id", "=", selection.occurrence_id).where("item_kind", "in", ["criterion", "plan_wide_criterion"]).executeTakeFirst();
    if (!criterion) return null;
    const captured = await trx.selectFrom("observation.item_occurrence as i")
      .innerJoin("observation.source_revision as r", (join) => join.onRef("i.producer", "=", "r.producer")
        .onRef("i.namespace", "=", "r.namespace").onRef("i.revision_id", "=", "r.revision_id"))
      .selectAll("i").select(["r.unit_id", "r.definition_id", "r.artifact_schema_version", "r.recorded_at"])
      .where("i.producer", "=", tenant.producer).where("i.namespace", "=", tenant.namespace)
      .where("i.run_id", "=", criterion.run_id).where("r.recorded_at", "<=", selection.as_of)
      .where("r.captured_at", "<=", selection.as_of).execute();
    if (!captured.some((row) => row.occurrence_id === criterion.occurrence_id)) return null;
    const occurrence_ids = captured.map((row) => row.occurrence_id);
    const logical_ids = captured.flatMap((row) => row.logical_item_id ? [row.logical_item_id] : []);
    const relations = await trx.selectFrom("observation.item_relation").selectAll()
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("recorded_at", "<=", selection.as_of)
      .where((eb) => eb.or([
        eb("source_occurrence_id", "in", occurrence_ids),
        eb("target_occurrence_id", "in", occurrence_ids),
        ...(logical_ids.length ? [eb("source_logical_item_id", "in", logical_ids), eb("target_logical_item_id", "in", logical_ids)] : []),
      ])).execute();
    const grades = await trx.selectFrom("observation.grade_observation as g")
      .innerJoin("observation.item_occurrence as i", (join) => join.onRef("i.producer", "=", "g.producer")
        .onRef("i.namespace", "=", "g.namespace").onRef("i.occurrence_id", "=", "g.subject_occurrence_id"))
      .innerJoin("observation.evaluator_definition as e", (join) => join.onRef("e.producer", "=", "g.producer")
        .onRef("e.namespace", "=", "g.namespace").onRef("e.evaluator_definition_id", "=", "g.evaluator_definition_id"))
      .selectAll("g").select(["e.kind", "e.provider", "e.model", "e.config_digest", "e.runtime_revision"])
      .where("g.producer", "=", tenant.producer).where("g.namespace", "=", tenant.namespace)
      .where("i.run_id", "=", criterion.run_id).where("g.recorded_at", "<=", selection.as_of).execute();
    const items: CompositeItem[] = captured.map((row) => ({ occurrence_id: row.occurrence_id as ItemOccurrenceId,
      revision_id: row.revision_id, stage: row.unit_id, artifact_kind: row.artifact_kind, item_kind: row.item_kind,
      logical_item_id: row.logical_item_id, definition_id: row.definition_id,
      artifact_schema_version: row.artifact_schema_version, recorded_at: row.recorded_at.toISOString() }));
    const selectedCriterion = items.find((row) => row.occurrence_id === criterion.occurrence_id);
    if (!selectedCriterion) return null;
    const judgments: CompositeJudgment[] = grades.map((row) => ({ observation_id: row.observation_id as GradeObservationId,
      subject_occurrence_id: row.subject_occurrence_id as ItemOccurrenceId, execution_id: row.execution_id,
      evidence_set_id: row.evidence_set_id, question_id: row.question_id as QuestionId, question_version: row.question_version,
      evaluator_definition_id: row.evaluator_definition_id, answer: row.answer_payload as unknown as GradeAnswer,
      supersedes_observation_id: row.supersedes_observation_id as GradeObservationId | null, recorded_at: row.recorded_at.toISOString(),
      evaluator: { kind: row.kind, provider: row.provider, model: row.model, config_digest: row.config_digest, runtime_revision: row.runtime_revision } }));
    return { criterion: selectedCriterion, items, relations, judgments, run_id: criterion.run_id };
  });
  if (!rows) return null;
  const support: GradingSupportRow[] = [];
  // Page the additive support read. A large run's constituents must not be truncated at 200.
  for (let offset = 0; ; offset += 200) {
    const page = await readGradingSupport(db, tenant, { run_id: rows.run_id, limit: 200, offset, as_of: selection.as_of });
    support.push(...page.items);
    if (offset + page.items.length >= page.total) break;
  }
  return deriveCriterionComposite({ ...rows, as_of: selection.as_of.toISOString(), support });
}
export interface CriterionCompositeSelection { readonly occurrence_id: string; readonly as_of: Date }
