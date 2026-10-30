import { sql } from "kysely";
import { COVERAGE_QUERY_VERSION, type CoverageProjection, type QuestionCoverage } from "../grading/coverage";
import { withTenant, type Database, type TenantScope } from "./database";

export interface CoverageSelection {
  readonly run_id: string;
  readonly revision_id: string | null;
  readonly question_id: string | null;
  readonly question_version: string | null;
}
interface CoverageRow {
  question_id: string;
  question_version: string;
  eligible: string;
  graded: string;
  blind: string;
  in_context: string;
  unknown: string;
  inapplicable: string;
  missing_evidence: string;
  invalid_reference: string;
  blocked_dependency: string;
  skipped_budget: string;
  lag_seconds: number | null;
}
/** Aggregate from the recorded eligibility decisions; only one row per question pin leaves the database. */
export async function readCoverage(db: Database, tenant: TenantScope, selection: CoverageSelection): Promise<CoverageProjection> {
  const rows = await withTenant(db, tenant, async (trx) => sql<CoverageRow>`
    WITH latest AS (
      SELECT DISTINCT ON (e.subject_occurrence_id, e.question_id, e.question_version)
        e.subject_occurrence_id, e.question_id, e.question_version, e.tag, e.recorded_at
      FROM observation.evaluation_eligibility e
      JOIN observation.item_occurrence i ON i.producer = e.producer AND i.namespace = e.namespace
        AND i.occurrence_id = e.subject_occurrence_id
      WHERE e.producer = ${tenant.producer} AND e.namespace = ${tenant.namespace}
        AND i.run_id = ${selection.run_id}
        AND (${selection.revision_id}::text IS NULL OR i.revision_id = ${selection.revision_id})
        AND (${selection.question_id}::text IS NULL OR e.question_id = ${selection.question_id})
        AND (${selection.question_version}::text IS NULL OR e.question_version = ${selection.question_version})
      ORDER BY e.subject_occurrence_id, e.question_id, e.question_version, e.recorded_at DESC, e.eligibility_id DESC
    ), counted AS (
      SELECT e.*, COALESCE(m.has_grade, false) AS has_grade,
        COALESCE(m.has_blind, false) AS has_blind,
        COALESCE(m.has_in_context, false) AS has_in_context,
        COALESCE(m.has_unknown, false) AS has_unknown
      FROM latest e LEFT JOIN LATERAL (
        SELECT count(*) > 0 AS has_grade,
          count(*) FILTER (WHERE g.collection_mode = 'blind') > 0 AS has_blind,
          count(*) FILTER (WHERE g.collection_mode = 'in_context') > 0 AS has_in_context,
          count(*) FILTER (WHERE g.collection_mode IS NULL) > 0 AS has_unknown
        FROM observation.grade_observation g
        JOIN observation.evaluator_definition d ON d.producer = g.producer AND d.namespace = g.namespace
          AND d.evaluator_definition_id = g.evaluator_definition_id
        WHERE g.producer = ${tenant.producer} AND g.namespace = ${tenant.namespace}
          AND g.subject_occurrence_id = e.subject_occurrence_id
          AND g.question_id = e.question_id AND g.question_version = e.question_version
          AND d.kind = 'human' AND g.evaluator_definition_id <> 'oakridge-operator-human'
      ) m ON true
    )
    SELECT question_id, question_version,
      count(*) FILTER (WHERE tag = 'eligible')::text AS eligible,
      count(*) FILTER (WHERE tag = 'eligible' AND has_grade)::text AS graded,
      count(*) FILTER (WHERE tag = 'eligible' AND has_blind)::text AS blind,
      count(*) FILTER (WHERE tag = 'eligible' AND has_in_context)::text AS in_context,
      count(*) FILTER (WHERE tag = 'eligible' AND has_unknown)::text AS unknown,
      count(*) FILTER (WHERE tag = 'inapplicable')::text AS inapplicable,
      count(*) FILTER (WHERE tag = 'missing_evidence')::text AS missing_evidence,
      count(*) FILTER (WHERE tag = 'invalid_reference')::text AS invalid_reference,
      count(*) FILTER (WHERE tag = 'blocked_dependency')::text AS blocked_dependency,
      count(*) FILTER (WHERE tag = 'skipped_budget')::text AS skipped_budget,
      EXTRACT(EPOCH FROM clock_timestamp() - max(recorded_at))::double precision AS lag_seconds
    FROM counted GROUP BY question_id, question_version ORDER BY question_id, question_version LIMIT 51
  `.execute(trx));
  const questions: QuestionCoverage[] = rows.rows.slice(0, 50).map((row) => {
    const exclusion_reasons = { inapplicable: Number(row.inapplicable), missing_evidence: Number(row.missing_evidence),
      invalid_reference: Number(row.invalid_reference), blocked_dependency: Number(row.blocked_dependency),
      skipped_budget: Number(row.skipped_budget) };
    return { question_id: row.question_id, question_version: row.question_version,
      eligible: Number(row.eligible), graded: Number(row.graded),
      graded_by_collection_mode: { blind: Number(row.blind), in_context: Number(row.in_context),
        unknown: Number(row.unknown) },
      excluded: Object.values(exclusion_reasons).reduce((sum, count) => sum + count, 0),
      exclusion_reasons, lag_seconds: row.lag_seconds };
  });
  return { run_id: selection.run_id, selection_revision_id: selection.revision_id,
    query_version: COVERAGE_QUERY_VERSION, questions, truncated: rows.rows.length > 50 };
}
