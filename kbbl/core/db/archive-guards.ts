import type { Database } from "bun:sqlite";
import { getEpicBySpec } from "./epics";
import { isFrozen } from "./epic-freeze";

function isSpecEpicArchived(db: Database, spec_id: string): boolean {
  const epic = getEpicBySpec(db, spec_id);
  return epic ? isFrozen(db, epic.id) : false;
}

export function isPlanEpicArchived(db: Database, plan_id: string): boolean {
  const row = db
    .prepare<{ spec_id: string }, [string]>("SELECT spec_id FROM plans WHERE id = ?")
    .get(plan_id);
  return row ? isSpecEpicArchived(db, row.spec_id) : false;
}

export function isCohortEpicArchived(db: Database, cohort_id: string): boolean {
  const row = db
    .prepare<{ spec_id: string }, [string]>(
      "SELECT p.spec_id FROM cohorts c JOIN plans p ON p.id = c.plan_id WHERE c.id = ?",
    )
    .get(cohort_id);
  return row ? isSpecEpicArchived(db, row.spec_id) : false;
}

export function isBriefEpicArchived(db: Database, brief_id: string): boolean {
  const row = db
    .prepare<{ spec_id: string }, [string]>(
      `SELECT p.spec_id
         FROM briefs b
         JOIN cohorts c ON c.id = b.cohort_id
         JOIN plans p ON p.id = c.plan_id
        WHERE b.id = ?`,
    )
    .get(brief_id);
  return row ? isSpecEpicArchived(db, row.spec_id) : false;
}
