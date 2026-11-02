import { COVERAGE_QUERY_VERSION, type CoverageProjection, type QuestionCoverage } from "../grading/coverage";
import { LANGFUSE_PILOT_QUESTIONS } from "../grading/catalogue/langfuse-pilot";
import { withTenant, type Database, type TenantScope } from "./database";
import { readDerivedEligibility } from "../producers/oakridge/gradeability";

export interface CoverageSelection {
  readonly run_id: string;
  readonly revision_id: string | null;
  readonly question_id: string | null;
  readonly question_version: string | null;
}

/** Current coverage always uses the captured-revision gradeability service. */
export async function readCoverage(db: Database, tenant: TenantScope, selection: CoverageSelection): Promise<CoverageProjection> {
  const pins = selection.question_id && selection.question_version
    ? [{ question_id: selection.question_id, question_version: selection.question_version }]
    : Object.values(LANGFUSE_PILOT_QUESTIONS).map(({ definition }) => ({
      question_id: definition.question_id, question_version: definition.question_version }));
  const questions: QuestionCoverage[] = [];
  for (const pin of pins) {
    const projection = await readQuestionCoverage(db, tenant, { ...selection, ...pin });
    questions.push(...projection.questions);
  }
  return { run_id: selection.run_id, selection_revision_id: selection.revision_id,
    query_version: COVERAGE_QUERY_VERSION, questions: questions.slice(0, 50), truncated: questions.length > 50 };
}

async function readQuestionCoverage(db: Database, tenant: TenantScope, selection: CoverageSelection): Promise<CoverageProjection> {
  const question_id = selection.question_id!;
  const question_version = selection.question_version!;
  const derived = await readDerivedEligibility(db, tenant, question_id, question_version,
    "live_all_revisions", selection.run_id);
  if (!derived.ok) {
    if (derived.error.code === "unknown_question_pin") return { run_id: selection.run_id,
      selection_revision_id: selection.revision_id, query_version: COVERAGE_QUERY_VERSION,
      questions: [], truncated: false };
    throw new Error(derived.error.detail);
  }
  const included = selection.revision_id ? await withTenant(db, tenant, async (trx) => {
    const rows = await trx.selectFrom("observation.item_occurrence").select("occurrence_id")
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("revision_id", "=", selection.revision_id).execute();
    return new Set(rows.map((row) => row.occurrence_id));
  }) : null;
  const rows = derived.value.filter((row) => included === null || included.has(row.subject_occurrence_id));
  const ids = rows.filter((row) => row.tag === "eligible").map((row) => row.subject_occurrence_id);
  const grades = ids.length === 0 ? [] : await withTenant(db, tenant, (trx) =>
    trx.selectFrom("observation.grade_observation as g")
      .innerJoin("observation.evaluator_definition as d", (join) => join
        .onRef("d.producer", "=", "g.producer").onRef("d.namespace", "=", "g.namespace")
        .onRef("d.evaluator_definition_id", "=", "g.evaluator_definition_id"))
      .select(["g.subject_occurrence_id", "g.evidence_set_id", "g.collection_mode", "g.question_id", "g.question_version"])
      .where("g.producer", "=", tenant.producer).where("g.namespace", "=", tenant.namespace)
      .where("g.subject_occurrence_id", "in", ids).where("d.kind", "=", "human")
      .where("g.evaluator_definition_id", "!=", "oakridge-operator-human")
      .where("g.question_id", "=", question_id).where("g.question_version", "=", question_version).execute());
  const modes = rows.filter((row) => row.tag === "eligible").map((row) => {
    const matching = grades.filter((grade) => grade.subject_occurrence_id === row.subject_occurrence_id
      && grade.evidence_set_id === row.payload.evidence_set_id);
    return new Set(matching.map((grade) => grade.collection_mode ?? "unknown"));
  });
  const exclusion_reasons = {
    inapplicable: rows.filter((row) => row.tag === "inapplicable").length,
    missing_evidence: rows.filter((row) => row.tag === "missing_evidence").length,
    invalid_reference: rows.filter((row) => row.tag === "invalid_reference").length,
    blocked_dependency: rows.filter((row) => row.tag === "blocked_dependency").length,
    skipped_budget: 0,
  };
  const question: QuestionCoverage = { question_id, question_version,
    eligible: modes.length, graded: modes.filter((mode) => mode.size > 0).length,
    graded_by_collection_mode: { blind: modes.filter((mode) => mode.has("blind")).length,
      in_context: modes.filter((mode) => mode.has("in_context")).length,
      unknown: modes.filter((mode) => mode.has("unknown")).length },
    excluded: exclusion_reasons.inapplicable + exclusion_reasons.missing_evidence
      + exclusion_reasons.invalid_reference + exclusion_reasons.blocked_dependency,
    exclusion_reasons, lag_seconds: null };
  return { run_id: selection.run_id, selection_revision_id: selection.revision_id,
    query_version: COVERAGE_QUERY_VERSION, questions: [question], truncated: false };
}
