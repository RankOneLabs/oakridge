import { Database } from "bun:sqlite";
import type { Spec } from "../types/task-tracker";

export function insertSpec(
  db: Database,
  {
    id,
    project_id,
    title,
    notes,
  }: { id: string; project_id: string; title: string; notes?: string | null },
): Spec {
  return db
    .prepare<Spec, [string, string, string, string | null]>(
      "INSERT INTO specs (id, project_id, title, notes) VALUES (?, ?, ?, ?) RETURNING *",
    )
    .get(id, project_id, title, notes ?? null)!;
}

export function getSpec(db: Database, id: string): Spec | null {
  return (
    db.prepare<Spec, [string]>("SELECT * FROM specs WHERE id = ?").get(id) ?? null
  );
}

export function listSpecsByProject(db: Database, project_id: string): Spec[] {
  return db
    .prepare<Spec, [string]>(
      "SELECT * FROM specs WHERE project_id = ? ORDER BY created_at, id",
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
