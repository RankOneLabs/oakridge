import type { Database } from "bun:sqlite";
import type { Cohort } from "../types/task-tracker";
import {
  applyCohortTransition,
  type CohortEvent,
  type CohortStatus,
} from "../orchestrator/state-machine";
import { getCohort } from "./cohorts";

export type CohortTransitionResult =
  | { ok: true; cohort: Cohort; from: CohortStatus; to: CohortStatus }
  | { ok: false; reason: "not_found" }
  | {
      ok: false;
      reason: "invalid_transition";
      current: CohortStatus;
      detail: string;
    };

export function transitionCohort(
  db: Database,
  cohort_id: string,
  event: CohortEvent,
): CohortTransitionResult {
  const cohort = getCohort(db, cohort_id);
  if (!cohort) return { ok: false, reason: "not_found" };

  const next = applyCohortTransition(cohort.status, event, cohort.pre_block_status);
  if (typeof next === "object") {
    return {
      ok: false,
      reason: "invalid_transition",
      current: cohort.status,
      detail: next.error,
    };
  }

  if (event === "block") {
    db.prepare(
      "UPDATE cohorts SET status = 'blocked', pre_block_status = ? WHERE id = ?",
    ).run(cohort.status, cohort_id);
  } else if (event === "unblock") {
    db.prepare(
      "UPDATE cohorts SET status = ?, pre_block_status = NULL WHERE id = ?",
    ).run(next, cohort_id);
  } else {
    db.prepare("UPDATE cohorts SET status = ? WHERE id = ?").run(next, cohort_id);
  }

  const updated = getCohort(db, cohort_id);
  if (!updated) return { ok: false, reason: "not_found" };
  return { ok: true, cohort: updated, from: cohort.status, to: next };
}
