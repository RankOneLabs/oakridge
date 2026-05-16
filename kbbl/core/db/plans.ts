import { Database } from "bun:sqlite";
import type { Plan } from "../types/task-tracker";

export function insertPlan(
  db: Database,
  {
    id,
    spec_id,
    model,
    predecessor_plan_id,
  }: { id: string; spec_id: string; model?: string | null; predecessor_plan_id?: string | null },
): Plan {
  return db
    .prepare<Plan, [string, string, string | null, string | null]>(
      "INSERT INTO plans (id, spec_id, model, predecessor_plan_id) VALUES (?, ?, ?, ?) RETURNING *",
    )
    .get(id, spec_id, model ?? null, predecessor_plan_id ?? null)!;
}

export function getPlan(db: Database, id: string): Plan | null {
  return (
    db.prepare<Plan, [string]>("SELECT * FROM plans WHERE id = ?").get(id) ?? null
  );
}

export function listPlansBySpec(db: Database, spec_id: string): Plan[] {
  return db
    .prepare<Plan, [string]>(
      "SELECT * FROM plans WHERE spec_id = ? ORDER BY created_at, id",
    )
    .all(spec_id);
}

export function listPlansByStatus(db: Database, status: Plan["status"]): Plan[] {
  return db
    .prepare<Plan, [string]>(
      "SELECT * FROM plans WHERE status = ? ORDER BY created_at DESC, id",
    )
    .all(status);
}

export function updatePlanFields(
  db: Database,
  id: string,
  fields: { model?: string | null },
): Plan | null {
  if (fields.model === undefined) return getPlan(db, id);
  const sql = "UPDATE plans SET model = ? WHERE id = ? RETURNING *";
  return (
    (db.prepare<Plan, [string | null, string]>(sql).get(fields.model, id) as Plan | undefined) ?? null
  );
}
