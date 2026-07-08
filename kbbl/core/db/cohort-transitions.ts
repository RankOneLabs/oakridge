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
  | {
      ok: false;
      reason: "not_found";
      operation: "transitionCohort";
      cohort_id: string;
      event: CohortEvent;
      detail: string;
    }
  | {
      ok: false;
      reason: "invalid_transition";
      operation: "transitionCohort";
      cohort_id: string;
      event: CohortEvent;
      current: CohortStatus;
      detail: string;
    };

function notFound(cohort_id: string, event: CohortEvent): CohortTransitionResult {
  return {
    ok: false,
    reason: "not_found",
    operation: "transitionCohort",
    cohort_id,
    event,
    detail: "cohort not found",
  };
}

function invalidTransition(
  cohort_id: string,
  event: CohortEvent,
  current: CohortStatus,
  detail: string,
): CohortTransitionResult {
  return {
    ok: false,
    reason: "invalid_transition",
    operation: "transitionCohort",
    cohort_id,
    event,
    current,
    detail,
  };
}

export function transitionCohort(
  db: Database,
  cohort_id: string,
  event: CohortEvent,
): CohortTransitionResult {
  const cohort = getCohort(db, cohort_id);
  if (!cohort) return notFound(cohort_id, event);
  return transitionCohortFromRow(db, cohort, event);
}

export function transitionCohortFromRow(
  db: Database,
  cohort: Cohort,
  event: CohortEvent,
): CohortTransitionResult {
  const cohort_id = cohort.id;
  const next = applyCohortTransition(cohort.status, event, cohort.pre_block_status);
  if (typeof next === "object") {
    return invalidTransition(cohort_id, event, cohort.status, next.error);
  }

  let changes = 0;
  if (event === "block") {
    changes = db.prepare(
      `UPDATE cohorts
          SET status = 'blocked', pre_block_status = ?
        WHERE id = ? AND status = ? AND pre_block_status IS ?`,
    ).run(cohort.status, cohort_id, cohort.status, cohort.pre_block_status).changes;
  } else if (event === "unblock") {
    changes = db.prepare(
      `UPDATE cohorts
          SET status = ?, pre_block_status = NULL
        WHERE id = ? AND status = ? AND pre_block_status IS ?`,
    ).run(next, cohort_id, cohort.status, cohort.pre_block_status).changes;
  } else {
    changes = db.prepare(
      `UPDATE cohorts
          SET status = ?
        WHERE id = ? AND status = ? AND pre_block_status IS ?`,
    ).run(next, cohort_id, cohort.status, cohort.pre_block_status).changes;
  }

  if (changes === 0) {
    const latest = getCohort(db, cohort_id);
    if (!latest) return notFound(cohort_id, event);
    return invalidTransition(
      cohort_id,
      event,
      latest.status,
      `cohort changed during transition; expected status=${cohort.status}, pre_block_status=${cohort.pre_block_status ?? "null"}`,
    );
  }

  const updated = getCohort(db, cohort_id);
  if (!updated) return notFound(cohort_id, event);
  return { ok: true, cohort: updated, from: cohort.status, to: next };
}
