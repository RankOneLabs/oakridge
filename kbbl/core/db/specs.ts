import { Database } from "bun:sqlite";
import type { Spec } from "../types/task-tracker";

export type SpecWithPlan = Spec & { plan_id: string | null; epic_id: string | null };

export function insertSpec(
  db: Database,
  {
    id,
    project_id,
    title,
    notes,
  }: { id: string; project_id: string; title: string; notes?: string | null },
): Spec {
  const n = notes ?? null;
  return db
    .prepare<Spec, [string, string, string, string | null, string | null]>(
      "INSERT INTO specs (id, project_id, title, notes, submitted_notes) VALUES (?, ?, ?, ?, ?) RETURNING *",
    )
    .get(id, project_id, title, n, n)!;
}

export function getSpec(db: Database, id: string): Spec | null {
  return (
    db.prepare<Spec, [string]>("SELECT * FROM specs WHERE id = ?").get(id) ?? null
  );
}

export function listSpecsByProject(db: Database, project_id: string): SpecWithPlan[] {
  // The correlated subquery surfaces the spec's most recent plan revision —
  // there can be many (rejected/superseded chain), and the sidebar wants the
  // one to deep-link to. PlanReviewView handles non-pending statuses, so we
  // don't filter by status here.
  return db
    .prepare<SpecWithPlan, [string]>(
      `SELECT s.*,
         (SELECT p.id FROM plans p
          WHERE p.spec_id = s.id
          ORDER BY p.created_at DESC, p.id DESC
          LIMIT 1) AS plan_id,
         (SELECT e.id FROM epics e
          WHERE e.spec_id = s.id
          ORDER BY e.created_at DESC, e.id DESC
          LIMIT 1) AS epic_id
       FROM specs s
       WHERE s.project_id = ?
       ORDER BY s.created_at, s.id`,
    )
    .all(project_id);
}

export function updateSpecFields(
  db: Database,
  id: string,
  fields: { title?: string; notes?: string | null },
): Spec | null {
  const sets: string[] = [];
  const params: (string | null)[] = [];

  if (fields.title !== undefined) {
    sets.push("title = ?");
    params.push(fields.title);
  }
  if (fields.notes !== undefined) {
    sets.push("notes = ?");
    params.push(fields.notes ?? null);
  }
  if (sets.length === 0) return getSpec(db, id);

  params.push(id);
  const sql = `UPDATE specs SET ${sets.join(", ")} WHERE id = ? RETURNING *`;
  return (db.prepare<Spec, (string | null)[]>(sql).get(...params) as Spec | undefined) ?? null;
}
