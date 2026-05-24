import { Database } from "bun:sqlite";

interface AssessmentRow {
  id: string;
  plan_id: string;
  summary: string;
  deviations_catalog: string;
  gap_analysis: string;
  fix_plan: string;
  model: string | null;
  created_at: string;
}

export interface DeviationsCatalogEntry {
  cohort_id: string;
  cohort_title: string;
  deviations: Array<{ from: string; actual: string; downstream_impact: string }>;
}

export interface Assessment {
  id: string;
  plan_id: string;
  summary: string;
  deviations_catalog: DeviationsCatalogEntry[];
  gap_analysis: string;
  fix_plan: string;
  model: string | null;
  created_at: string;
}

function parseAssessmentRow(row: AssessmentRow): Assessment {
  const parsed: unknown = JSON.parse(row.deviations_catalog);
  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid deviations_catalog for assessment ${row.id}: expected JSON array`);
  }
  return {
    ...row,
    deviations_catalog: parsed as DeviationsCatalogEntry[],
  };
}

export function insertAssessment(
  db: Database,
  {
    id,
    plan_id,
    summary,
    deviations_catalog,
    gap_analysis,
    fix_plan,
    model,
  }: {
    id: string;
    plan_id: string;
    summary: string;
    deviations_catalog: DeviationsCatalogEntry[];
    gap_analysis: string;
    fix_plan: string;
    model?: string | null;
  },
): Assessment {
  const row = db
    .prepare<AssessmentRow, [string, string, string, string, string, string, string | null]>(
      `INSERT INTO assessments (id, plan_id, summary, deviations_catalog, gap_analysis, fix_plan, model)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(id, plan_id, summary, JSON.stringify(deviations_catalog), gap_analysis, fix_plan, model ?? null)!;
  return parseAssessmentRow(row);
}

export function getAssessment(db: Database, id: string): Assessment | null {
  const row = db.prepare<AssessmentRow, [string]>("SELECT * FROM assessments WHERE id = ?").get(id);
  return row ? parseAssessmentRow(row) : null;
}

export function getAssessmentByPlan(db: Database, plan_id: string): Assessment | null {
  const row = db
    .prepare<AssessmentRow, [string]>(
      "SELECT * FROM assessments WHERE plan_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .get(plan_id);
  return row ? parseAssessmentRow(row) : null;
}

export function listAssessments(db: Database): Assessment[] {
  return db
    .prepare<AssessmentRow, []>("SELECT * FROM assessments ORDER BY created_at DESC, id DESC")
    .all()
    .map(parseAssessmentRow);
}
