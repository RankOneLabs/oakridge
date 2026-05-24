import { Database } from "bun:sqlite";
import type { Brief } from "../types/task-tracker";

interface BriefRow {
  id: string;
  cohort_id: string;
  status: string;
  predecessor_brief_id: string | null;
  model: string | null;
  goal: string;
  files_in_scope: string;
  decisions_made: string;
  approaches_rejected: string;
  next_action: string;
  debrief: string | null;
  pr_url: string | null;
  rejection_reason: string | null;
  created_at: string;
}

function parseBriefRow(row: BriefRow): Brief {
  return {
    ...row,
    status: row.status as Brief["status"],
    files_in_scope: JSON.parse(row.files_in_scope),
    decisions_made: JSON.parse(row.decisions_made),
    approaches_rejected: JSON.parse(row.approaches_rejected),
  };
}

export function insertBrief(
  db: Database,
  {
    id,
    cohort_id,
    model,
    predecessor_brief_id,
    goal,
    files_in_scope,
    decisions_made,
    approaches_rejected,
    next_action,
  }: {
    id: string;
    cohort_id: string;
    model?: string | null;
    predecessor_brief_id?: string | null;
    goal: string;
    files_in_scope: Brief["files_in_scope"];
    decisions_made: Brief["decisions_made"];
    approaches_rejected: Brief["approaches_rejected"];
    next_action: string;
  },
): Brief {
  const row = db
    .prepare<BriefRow, [string, string, string | null, string | null, string, string, string, string, string]>(
      `INSERT INTO briefs
         (id, cohort_id, model, predecessor_brief_id, goal, files_in_scope, decisions_made, approaches_rejected, next_action)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      id,
      cohort_id,
      model ?? null,
      predecessor_brief_id ?? null,
      goal,
      JSON.stringify(files_in_scope),
      JSON.stringify(decisions_made),
      JSON.stringify(approaches_rejected),
      next_action,
    )!;
  return parseBriefRow(row);
}

export function getBrief(db: Database, id: string): Brief | null {
  const row = db.prepare<BriefRow, [string]>("SELECT * FROM briefs WHERE id = ?").get(id);
  return row ? parseBriefRow(row) : null;
}

export function getLatestApprovedBriefByCohort(db: Database, cohort_id: string): Brief | null {
  const row = db
    .prepare<BriefRow, [string]>(
      "SELECT * FROM briefs WHERE cohort_id = ? AND status = 'approved' ORDER BY created_at DESC LIMIT 1",
    )
    .get(cohort_id);
  return row ? parseBriefRow(row) : null;
}

export function listBriefsByCohort(db: Database, cohort_id: string): Brief[] {
  return db
    .prepare<BriefRow, [string]>(
      "SELECT * FROM briefs WHERE cohort_id = ? ORDER BY created_at, id",
    )
    .all(cohort_id)
    .map(parseBriefRow);
}

export function listBriefsByStatus(db: Database, status: Brief["status"]): Brief[] {
  return db
    .prepare<BriefRow, [string]>(
      "SELECT * FROM briefs WHERE status = ? ORDER BY created_at DESC, id",
    )
    .all(status)
    .map(parseBriefRow);
}

export function updateBriefFields(
  db: Database,
  id: string,
  fields: {
    goal?: string;
    files_in_scope?: Brief["files_in_scope"];
    decisions_made?: Brief["decisions_made"];
    approaches_rejected?: Brief["approaches_rejected"];
    next_action?: string;
    model?: string | null;
  },
): Brief | null {
  const sets: string[] = [];
  const params: (string | null)[] = [];

  if (fields.goal !== undefined) {
    sets.push("goal = ?");
    params.push(fields.goal);
  }
  if (fields.files_in_scope !== undefined) {
    sets.push("files_in_scope = ?");
    params.push(JSON.stringify(fields.files_in_scope));
  }
  if (fields.decisions_made !== undefined) {
    sets.push("decisions_made = ?");
    params.push(JSON.stringify(fields.decisions_made));
  }
  if (fields.approaches_rejected !== undefined) {
    sets.push("approaches_rejected = ?");
    params.push(JSON.stringify(fields.approaches_rejected));
  }
  if (fields.next_action !== undefined) {
    sets.push("next_action = ?");
    params.push(fields.next_action);
  }
  if (fields.model !== undefined) {
    sets.push("model = ?");
    params.push(fields.model ?? null);
  }
  if (sets.length === 0) return getBrief(db, id);

  params.push(id);
  const sql = `UPDATE briefs SET ${sets.join(", ")} WHERE id = ? RETURNING *`;
  const row = (db.prepare<BriefRow, (string | null)[]>(sql).get(...params) as BriefRow | undefined);
  return row ? parseBriefRow(row) : null;
}

export function updateBriefDebrief(
  db: Database,
  id: string,
  { debrief, pr_url }: { debrief: string; pr_url?: string | null },
): Brief | null {
  const row = db
    .prepare<BriefRow, [string, string | null, string]>(
      "UPDATE briefs SET debrief = ?, pr_url = COALESCE(?, pr_url) WHERE id = ? RETURNING *",
    )
    .get(debrief, pr_url ?? null, id) as BriefRow | undefined;
  return row ? parseBriefRow(row) : null;
}
