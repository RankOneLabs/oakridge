import { sql } from "kysely";
import { COVERAGE_QUERY_VERSION, DISAGREEMENT_POLICY_VERSION, type CoverageProjection, type QuestionCoverage } from "../grading/coverage";
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
  machine_graded: string;
  pending: string;
  failed: string;
  disagreement: string;
  selection_versions: string[];
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
        e.subject_occurrence_id, e.question_id, e.question_version, e.tag, e.recorded_at, i.extractor_version
      FROM observation.evaluation_eligibility e
      JOIN observation.item_occurrence i ON i.producer = e.producer AND i.namespace = e.namespace
        AND i.occurrence_id = e.subject_occurrence_id
      WHERE e.producer = ${tenant.producer} AND e.namespace = ${tenant.namespace}
        AND i.run_id = ${selection.run_id}
        AND (${selection.revision_id}::text IS NULL OR i.revision_id = ${selection.revision_id})
        AND (${selection.question_id}::text IS NULL OR e.question_id = ${selection.question_id})
        AND (${selection.question_version}::text IS NULL OR e.question_version = ${selection.question_version})
      ORDER BY e.subject_occurrence_id, e.question_id, e.question_version, e.recorded_at DESC, e.eligibility_id DESC
    ), versions AS (
      SELECT COALESCE(array_agg(DISTINCT extractor_version ORDER BY extractor_version)
        FILTER (WHERE tag = 'eligible'), ARRAY[]::text[]) AS selection_versions FROM latest
    ), eligible_subjects AS (
      SELECT subject_occurrence_id, question_id, question_version
      FROM latest WHERE tag = 'eligible'
    ), execution_state AS (
      SELECT x.subject_occurrence_id, x.question_id, x.question_version,
        (array_agg(x.status ORDER BY x.started_at DESC, x.execution_id DESC))[1] AS latest_status,
        bool_or(x.status = 'completed') AS has_completed
      FROM observation.evaluation_execution x
      JOIN eligible_subjects e ON e.subject_occurrence_id = x.subject_occurrence_id
        AND e.question_id = x.question_id AND e.question_version = x.question_version
      WHERE x.producer = ${tenant.producer} AND x.namespace = ${tenant.namespace}
      GROUP BY x.subject_occurrence_id, x.question_id, x.question_version
    ), counted AS (
      SELECT e.*, COALESCE(m.has_grade, false) AS has_grade,
        COALESCE(m.has_blind, false) AS has_blind,
        COALESCE(m.has_in_context, false) AS has_in_context,
        COALESCE(m.has_unknown, false) AS has_unknown,
        machine.has_machine_grade,
        (jobs.has_pending AND NOT COALESCE(executions.has_completed, false)) AS is_pending,
        ((executions.latest_status = 'failed' OR jobs.has_terminal_failure)
          AND NOT grades.has_any_grade) AS is_failed,
        disagreement.has_disagreement
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
      LEFT JOIN LATERAL (
        SELECT EXISTS (
          SELECT 1 FROM observation.grade_observation g
          JOIN observation.evaluator_definition d ON d.producer = g.producer AND d.namespace = g.namespace
            AND d.evaluator_definition_id = g.evaluator_definition_id
          WHERE g.producer = ${tenant.producer} AND g.namespace = ${tenant.namespace}
            AND g.subject_occurrence_id = e.subject_occurrence_id
            AND g.question_id = e.question_id AND g.question_version = e.question_version
            AND d.kind IN ('model', 'code')
        ) AS has_machine_grade
      ) machine ON true
      LEFT JOIN LATERAL (
        SELECT EXISTS (
          SELECT 1 FROM observation.grade_observation g
          WHERE g.producer = ${tenant.producer} AND g.namespace = ${tenant.namespace}
            AND g.subject_occurrence_id = e.subject_occurrence_id
            AND g.question_id = e.question_id AND g.question_version = e.question_version
        ) AS has_any_grade
      ) grades ON true
      LEFT JOIN execution_state executions ON executions.subject_occurrence_id = e.subject_occurrence_id
        AND executions.question_id = e.question_id AND executions.question_version = e.question_version
      LEFT JOIN LATERAL (
        SELECT EXISTS (SELECT 1 FROM observation.grading_job j
          WHERE j.producer = ${tenant.producer} AND j.namespace = ${tenant.namespace}
            AND j.subject_occurrence_id = e.subject_occurrence_id
            AND j.question_id = e.question_id AND j.question_version = e.question_version
            AND j.state IN ('queued', 'claimed', 'reclaimable')) AS has_pending,
          EXISTS (SELECT 1 FROM observation.grading_job j
          WHERE j.producer = ${tenant.producer} AND j.namespace = ${tenant.namespace}
            AND j.subject_occurrence_id = e.subject_occurrence_id
            AND j.question_id = e.question_id AND j.question_version = e.question_version
            AND j.state = 'terminal' AND j.terminal_cause IS NOT NULL) AS has_terminal_failure
      ) jobs ON true
      LEFT JOIN LATERAL (
        SELECT EXISTS (
          WITH current_answers AS (
            SELECT DISTINCT ON (d.kind, g.evidence_set_id)
              d.kind, g.evidence_set_id, g.answer_kind, g.answer_state, g.answer_payload
            FROM observation.grade_observation g
            JOIN observation.evaluator_definition d ON d.producer = g.producer AND d.namespace = g.namespace
              AND d.evaluator_definition_id = g.evaluator_definition_id
            WHERE g.producer = ${tenant.producer} AND g.namespace = ${tenant.namespace}
              AND g.subject_occurrence_id = e.subject_occurrence_id
              AND g.question_id = e.question_id AND g.question_version = e.question_version
            ORDER BY d.kind, g.evidence_set_id, g.recorded_at DESC, g.observation_id DESC
          )
          SELECT 1 FROM current_answers human
          JOIN current_answers machine ON machine.evidence_set_id = human.evidence_set_id
            AND machine.kind IN ('model', 'code')
          WHERE human.kind = 'human' AND human.answer_state = 'answered'
            AND machine.answer_state = 'answered' AND human.answer_kind = machine.answer_kind
            AND human.answer_payload->'value' IS DISTINCT FROM machine.answer_payload->'value'
        ) AS has_disagreement
      ) disagreement ON true
    )
    SELECT question_id, question_version, versions.selection_versions,
      count(*) FILTER (WHERE tag = 'eligible')::text AS eligible,
      count(*) FILTER (WHERE tag = 'eligible' AND has_grade)::text AS graded,
      count(*) FILTER (WHERE tag = 'eligible' AND has_machine_grade)::text AS machine_graded,
      count(*) FILTER (WHERE tag = 'eligible' AND is_pending)::text AS pending,
      count(*) FILTER (WHERE tag = 'eligible' AND is_failed)::text AS failed,
      count(*) FILTER (WHERE tag = 'eligible' AND has_disagreement)::text AS disagreement,
      count(*) FILTER (WHERE tag = 'eligible' AND has_blind)::text AS blind,
      count(*) FILTER (WHERE tag = 'eligible' AND has_in_context)::text AS in_context,
      count(*) FILTER (WHERE tag = 'eligible' AND has_unknown)::text AS unknown,
      count(*) FILTER (WHERE tag = 'inapplicable')::text AS inapplicable,
      count(*) FILTER (WHERE tag = 'missing_evidence')::text AS missing_evidence,
      count(*) FILTER (WHERE tag = 'invalid_reference')::text AS invalid_reference,
      count(*) FILTER (WHERE tag = 'blocked_dependency')::text AS blocked_dependency,
      count(*) FILTER (WHERE tag = 'skipped_budget')::text AS skipped_budget,
      EXTRACT(EPOCH FROM clock_timestamp() - max(recorded_at))::double precision AS lag_seconds
    FROM counted CROSS JOIN versions
    GROUP BY question_id, question_version, versions.selection_versions
    ORDER BY question_id, question_version LIMIT 51
  `.execute(trx));
  const questions: QuestionCoverage[] = rows.rows.slice(0, 50).map((row) => {
    const exclusion_reasons = { inapplicable: Number(row.inapplicable), missing_evidence: Number(row.missing_evidence),
      invalid_reference: Number(row.invalid_reference), blocked_dependency: Number(row.blocked_dependency),
      skipped_budget: Number(row.skipped_budget) };
    return { question_id: row.question_id, question_version: row.question_version,
      eligible: Number(row.eligible), human_label_graded: Number(row.graded), graded: Number(row.graded),
      machine_graded: Number(row.machine_graded), pending: Number(row.pending),
      failed: Number(row.failed), disagreement: Number(row.disagreement),
      graded_by_collection_mode: { blind: Number(row.blind), in_context: Number(row.in_context),
        unknown: Number(row.unknown) },
      excluded: Object.values(exclusion_reasons).reduce((sum, count) => sum + count, 0),
      exclusion_reasons, lag_seconds: row.lag_seconds };
  });
  return { run_id: selection.run_id, selection_revision_id: selection.revision_id,
    query_version: COVERAGE_QUERY_VERSION, selection_versions: rows.rows[0]?.selection_versions ?? [],
    disagreement_policy_version: DISAGREEMENT_POLICY_VERSION,
    questions, truncated: rows.rows.length > 50 };
}
