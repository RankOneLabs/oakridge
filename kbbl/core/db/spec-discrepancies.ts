import { Database } from "bun:sqlite";
import type { SpecDiscrepancy, SpecDiscrepancyStatus } from "../types/task-tracker";

export type { SpecDiscrepancy };

export function insertSpecDiscrepancy(
  db: Database,
  {
    id,
    spec_id,
    spec_assumption,
    code_reality,
    resolution,
    status,
  }: {
    id: string;
    spec_id: string;
    spec_assumption: string;
    code_reality: string;
    resolution?: string | null;
    status: SpecDiscrepancyStatus;
  },
): SpecDiscrepancy {
  return db
    .prepare<SpecDiscrepancy, [string, string, string, string, string | null, SpecDiscrepancyStatus]>(
      `INSERT INTO spec_discrepancies (id, spec_id, spec_assumption, code_reality, resolution, status)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(id, spec_id, spec_assumption, code_reality, resolution ?? null, status)!;
}

export function getSpecDiscrepancy(db: Database, id: string): SpecDiscrepancy | null {
  return (
    db
      .prepare<SpecDiscrepancy, [string]>("SELECT * FROM spec_discrepancies WHERE id = ?")
      .get(id) ?? null
  );
}

export function listSpecDiscrepancies(db: Database, spec_id: string): SpecDiscrepancy[] {
  return db
    .prepare<SpecDiscrepancy, [string]>(
      "SELECT * FROM spec_discrepancies WHERE spec_id = ? ORDER BY created_at, id",
    )
    .all(spec_id);
}

export function countOpenDiscrepancies(db: Database, spec_id: string): number {
  const row = db
    .prepare<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM spec_discrepancies WHERE spec_id = ? AND status = 'open'",
    )
    .get(spec_id);
  return row?.n ?? 0;
}

export function listResolvedDiscrepanciesBySpec(db: Database, spec_id: string): SpecDiscrepancy[] {
  return db
    .prepare<SpecDiscrepancy, [string]>(
      "SELECT * FROM spec_discrepancies WHERE spec_id = ? AND status = 'resolved' ORDER BY created_at, id",
    )
    .all(spec_id);
}

export function updateSpecDiscrepancy(
  db: Database,
  id: string,
  fields: { resolution?: string | null; status?: SpecDiscrepancyStatus },
): SpecDiscrepancy | null {
  const sets: string[] = [];
  const params: (string | null)[] = [];

  if (fields.resolution !== undefined) {
    sets.push("resolution = ?");
    params.push(fields.resolution ?? null);
  }
  if (fields.status !== undefined) {
    sets.push("status = ?");
    params.push(fields.status);
  }
  if (sets.length === 0) return getSpecDiscrepancy(db, id);

  params.push(id);
  const sql = `UPDATE spec_discrepancies SET ${sets.join(", ")} WHERE id = ? RETURNING *`;
  return (
    (db.prepare<SpecDiscrepancy, (string | null)[]>(sql).get(...params) as SpecDiscrepancy | undefined) ?? null
  );
}
