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

/**
 * Render resolved discrepancies as a spec "Amendments" section, meant to be
 * appended to the spec notes at approval so the amended spec is the single
 * source of truth for every downstream stage (plan_writer, brief_writer,
 * build) — they never have to reconcile original spec text against a separate
 * resolutions sidecar. Returns "" when there are no resolved discrepancies, so
 * callers append nothing and the original notes are preserved verbatim.
 */
export function renderSpecAmendments(discrepancies: SpecDiscrepancy[]): string {
  const resolved = discrepancies.filter((d) => d.status === "resolved");
  if (resolved.length === 0) return "";

  const body = resolved
    .map((r, i) =>
      [
        `### ${i + 1}. ${r.spec_assumption}`,
        "",
        `**Code reality:** ${r.code_reality}`,
        "",
        `**Resolution:** ${r.resolution ?? "(no resolution recorded)"}`,
      ].join("\n"),
    )
    .join("\n\n");

  return [
    "",
    "",
    "## Amendments (resolved discrepancies)",
    "",
    "The assumptions below conflicted with the codebase and were resolved by the operator. Each resolution is a binding amendment to the spec above and overrides any conflicting text.",
    "",
    body,
  ].join("\n");
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
