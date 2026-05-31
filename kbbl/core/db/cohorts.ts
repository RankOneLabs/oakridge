import { Database } from "bun:sqlite";
import type { Cohort, CohortDependency } from "../types/task-tracker";

export function insertCohort(
  db: Database,
  {
    id,
    plan_id,
    title,
    notes,
    position,
  }: { id: string; plan_id: string; title: string; notes?: string | null; position: number },
): Cohort {
  return db
    .prepare<Cohort, [string, string, string, string | null, number]>(
      "INSERT INTO cohorts (id, plan_id, title, notes, position) VALUES (?, ?, ?, ?, ?) RETURNING *",
    )
    .get(id, plan_id, title, notes ?? null, position)!;
}

export function getCohort(db: Database, id: string): Cohort | null {
  return (
    db.prepare<Cohort, [string]>("SELECT * FROM cohorts WHERE id = ?").get(id) ?? null
  );
}

export function listCohortsByPlan(db: Database, plan_id: string): Cohort[] {
  return db
    .prepare<Cohort, [string]>(
      "SELECT * FROM cohorts WHERE plan_id = ? ORDER BY position, id",
    )
    .all(plan_id);
}

export function updateCohortFields(
  db: Database,
  id: string,
  fields: { title?: string; notes?: string | null; position?: number },
): Cohort | null {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  if (fields.title !== undefined) {
    sets.push("title = ?");
    params.push(fields.title);
  }
  if (fields.notes !== undefined) {
    sets.push("notes = ?");
    params.push(fields.notes ?? null);
  }
  if (fields.position !== undefined) {
    sets.push("position = ?");
    params.push(fields.position);
  }
  if (sets.length === 0) return getCohort(db, id);

  params.push(id);
  const sql = `UPDATE cohorts SET ${sets.join(", ")} WHERE id = ? RETURNING *`;
  return (
    (db.prepare<Cohort, (string | number | null)[]>(sql).get(...params) as Cohort | undefined) ?? null
  );
}

export function insertCohortDependency(
  db: Database,
  { id, from_cohort_id, to_cohort_id }: { id: string; from_cohort_id: string; to_cohort_id: string },
): CohortDependency {
  return db
    .prepare<CohortDependency, [string, string, string]>(
      "INSERT INTO cohort_dependencies (id, from_cohort_id, to_cohort_id) VALUES (?, ?, ?) RETURNING *",
    )
    .get(id, from_cohort_id, to_cohort_id)!;
}

export function listDependenciesByPlan(db: Database, plan_id: string): CohortDependency[] {
  return db
    .prepare<CohortDependency, [string]>(
      `SELECT cd.id, cd.from_cohort_id, cd.to_cohort_id
       FROM cohort_dependencies cd
       JOIN cohorts c ON c.id = cd.from_cohort_id
       WHERE c.plan_id = ?
       ORDER BY cd.rowid`,
    )
    .all(plan_id);
}

export function deleteCohortDependency(
  db: Database,
  id: string,
): CohortDependency | null {
  return (
    db
      .prepare<CohortDependency, [string]>(
        "DELETE FROM cohort_dependencies WHERE id = ? RETURNING id, from_cohort_id, to_cohort_id",
      )
      .get(id) ?? null
  );
}

/**
 * Count this cohort's predecessor cohorts that are not yet `done`. Zero means
 * all dependencies are built and the cohort is clear to build. Single source of
 * truth for the dependency-readiness rule shared by brief approval, the
 * done/merge fan-out, and the manual build-dispatch guard.
 */
export function countUnmetDependencies(db: Database, cohort_id: string): number {
  return db
    .prepare<{ cnt: number }, [string]>(
      `SELECT COUNT(*) AS cnt
       FROM cohort_dependencies cd
       JOIN cohorts c ON c.id = cd.from_cohort_id
       WHERE cd.to_cohort_id = ? AND c.status != 'done'`,
    )
    .get(cohort_id)!.cnt;
}

export function listDependenciesByCohort(db: Database, cohort_id: string): CohortDependency[] {
  return db
    .prepare<CohortDependency, [string, string]>(
      `SELECT id, from_cohort_id, to_cohort_id FROM cohort_dependencies
       WHERE from_cohort_id = ? OR to_cohort_id = ?
       ORDER BY rowid`,
    )
    .all(cohort_id, cohort_id);
}
