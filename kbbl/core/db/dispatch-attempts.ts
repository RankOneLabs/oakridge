import type { Database } from "bun:sqlite";

export type DispatchAttemptStatus =
  | "dispatching"
  | "running"
  | "dispatch_failed"
  | "succeeded"
  | "cancelled";

export type DispatchEntityKind = "spec" | "cohort" | "brief" | "plan";

export interface DispatchAttempt {
  id: string;
  entity_kind: DispatchEntityKind;
  entity_id: string;
  stage: string;
  epic_id: string | null;
  cohort_id: string | null;
  attempt_number: number;
  status: DispatchAttemptStatus;
  intended_session_ref: string | null;
  actual_session_ref: string | null;
  branch_name: string | null;
  worktree_path: string | null;
  predecessor_attempt_id: string | null;
  last_error: string | null;
  recovery_hint: string | null;
  created_at: string;
  updated_at: string;
}

export type ClaimResult =
  | { claimed: true; attempt: DispatchAttempt }
  | { claimed: false; active: DispatchAttempt };

/**
 * Format attempt number as a zero-padded suffix string, e.g. 1 → "attempt-001".
 */
export function formatAttemptSuffix(attempt_number: number): string {
  return `attempt-${String(attempt_number).padStart(3, "0")}`;
}

/**
 * Try to acquire the dispatch claim for an entity/stage pair inside a single
 * transaction. On success, inserts a new dispatch_attempt with
 * status='dispatching' and returns it. On conflict (another attempt is already
 * dispatching or running), returns the active attempt without inserting.
 *
 * Attempt numbers are monotonic per entity/stage; the new attempt carries the
 * latest finished attempt as its predecessor so callers can trace the retry chain.
 */
export function claimDispatch(
  db: Database,
  params: {
    id: string;
    entity_kind: DispatchEntityKind;
    entity_id: string;
    stage: string;
    epic_id?: string | null;
    cohort_id?: string | null;
  },
): ClaimResult {
  return db.transaction((): ClaimResult => {
    // Compute next attempt_number and predecessor from the most recent attempt.
    const prevRow = db
      .prepare<{ id: string; attempt_number: number }, [string, string, string]>(
        `SELECT id, attempt_number FROM dispatch_attempts
          WHERE entity_kind = ? AND entity_id = ? AND stage = ?
          ORDER BY attempt_number DESC LIMIT 1`,
      )
      .get(params.entity_kind, params.entity_id, params.stage);

    const attempt_number = (prevRow?.attempt_number ?? 0) + 1;
    const predecessor_attempt_id = prevRow?.id ?? null;

    try {
      const row = db
        .prepare<DispatchAttempt, [string, string, string, string, string | null, string | null, number, string | null]>(
          `INSERT INTO dispatch_attempts
             (id, entity_kind, entity_id, stage, epic_id, cohort_id, attempt_number, predecessor_attempt_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING *`,
        )
        .get(
          params.id,
          params.entity_kind,
          params.entity_id,
          params.stage,
          params.epic_id ?? null,
          params.cohort_id ?? null,
          attempt_number,
          predecessor_attempt_id,
        )!;
      return { claimed: true, attempt: row };
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
        // Another attempt is already active — return it so callers can surface
        // the conflict to the operator without spawning a duplicate.
        const active = getActiveAttempt(db, params.entity_kind, params.entity_id, params.stage);
        if (!active) throw err; // should never happen if constraint fired
        return { claimed: false, active };
      }
      throw err;
    }
  })();
}

/**
 * Persist branch and worktree names on an attempt after they are computed
 * from the attempt_number. Called immediately after claimDispatch succeeds.
 */
export function updateAttemptBranchInfo(
  db: Database,
  id: string,
  info: { branch_name: string | null; worktree_path: string | null },
): void {
  db.prepare(
    `UPDATE dispatch_attempts
        SET branch_name = ?, worktree_path = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
  ).run(info.branch_name, info.worktree_path, id);
}

/**
 * Transition a dispatching attempt to running once the session has been
 * spawned. Persists the actual session ref returned by the session manager.
 */
export function markAttemptRunning(
  db: Database,
  id: string,
  actual_session_ref: string,
): void {
  db.prepare(
    `UPDATE dispatch_attempts
        SET status = 'running', actual_session_ref = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
  ).run(actual_session_ref, id);
}

/**
 * Mark an attempt as dispatch_failed, clear the active claim, and record why
 * so operators can triage and retry. Safe to call for both dispatching and
 * running status rows.
 */
export function markAttemptFailed(
  db: Database,
  id: string,
  opts: { last_error: string; recovery_hint?: string },
): void {
  const attempt = getAttempt(db, id);
  db.prepare(
    `UPDATE dispatch_attempts
        SET status = 'dispatch_failed',
            last_error = ?,
            recovery_hint = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
  ).run(opts.last_error, opts.recovery_hint ?? "Retry dispatch manually.", id);
  if (attempt?.actual_session_ref) {
    clearOwnerSessionRef(db, attempt);
  }
}

/**
 * Mark an attempt as succeeded after the session has completed its work and
 * produced the expected output artifact. Optional — used by monitors that
 * close out completed attempts; dispatch safety does not depend on it.
 */
export function markAttemptSucceeded(db: Database, id: string): void {
  db.prepare(
    `UPDATE dispatch_attempts
        SET status = 'succeeded', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
  ).run(id);
}

export function markRunningAttemptSucceededBySessionRef(
  db: Database,
  session_ref: string,
): DispatchAttempt | null {
  const attempt = db
    .prepare<DispatchAttempt, [string]>(
      `UPDATE dispatch_attempts
          SET status = 'succeeded', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE actual_session_ref = ? AND status = 'running'
        RETURNING *`,
    )
    .get(session_ref) ?? null;
  if (attempt?.actual_session_ref) {
    clearOwnerSessionRef(db, attempt);
  }
  return attempt;
}

/**
 * Return the single active (dispatching or running) attempt for an
 * entity/stage pair, or null if none is active. The partial unique index
 * guarantees at most one row matches.
 */
export function getActiveAttempt(
  db: Database,
  entity_kind: DispatchEntityKind,
  entity_id: string,
  stage: string,
): DispatchAttempt | null {
  return (
    db
      .prepare<DispatchAttempt, [string, string, string]>(
        `SELECT * FROM dispatch_attempts
          WHERE entity_kind = ? AND entity_id = ? AND stage = ?
            AND (status = 'dispatching' OR status = 'running')`,
      )
      .get(entity_kind, entity_id, stage) ?? null
  );
}

/**
 * List all active (dispatching or running) attempts across all entities and
 * stages. Used by boot reconciliation to find stranded dispatches left by a
 * previous process.
 */
export function listActiveAttempts(db: Database): DispatchAttempt[] {
  return db
    .prepare<DispatchAttempt, []>(
      `SELECT * FROM dispatch_attempts
        WHERE status = 'dispatching' OR status = 'running'
        ORDER BY created_at`,
    )
    .all();
}

/**
 * Fetch a single dispatch_attempt by id.
 */
export function getAttempt(db: Database, id: string): DispatchAttempt | null {
  return (
    db
      .prepare<DispatchAttempt, [string]>("SELECT * FROM dispatch_attempts WHERE id = ?")
      .get(id) ?? null
  );
}

export function listDispatchAttempts(
  db: Database,
  filters: {
    status?: DispatchAttemptStatus;
    entity_kind?: DispatchEntityKind;
    entity_id?: string;
    stage?: string;
  } = {},
): DispatchAttempt[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filters.status) {
    clauses.push("status = ?");
    params.push(filters.status);
  }
  if (filters.entity_kind) {
    clauses.push("entity_kind = ?");
    params.push(filters.entity_kind);
  }
  if (filters.entity_id) {
    clauses.push("entity_id = ?");
    params.push(filters.entity_id);
  }
  if (filters.stage) {
    clauses.push("stage = ?");
    params.push(filters.stage);
  }

  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  return db
    .prepare<DispatchAttempt, string[]>(
      `SELECT * FROM dispatch_attempts${where} ORDER BY created_at DESC, attempt_number DESC`,
    )
    .all(...params);
}

function clearOwnerSessionRef(db: Database, attempt: DispatchAttempt): void {
  const sessionRef = attempt.actual_session_ref;
  if (!sessionRef) return;

  const clearEntity = (table: "specs" | "cohorts" | "plans", id: string) => {
    db.prepare(
      `UPDATE ${table}
          SET current_session_ref = NULL, current_session_stage = NULL
        WHERE id = ?
          AND current_session_stage = ?
          AND current_session_ref = ?`,
    ).run(id, attempt.stage, sessionRef);
  };

  switch (attempt.entity_kind) {
    case "spec":
      clearEntity("specs", attempt.entity_id);
      break;
    case "cohort":
      clearEntity("cohorts", attempt.entity_id);
      break;
    case "plan":
      clearEntity("plans", attempt.entity_id);
      break;
    case "brief": {
      const cohortId = attempt.cohort_id ?? db
        .prepare<{ cohort_id: string }, [string]>("SELECT cohort_id FROM briefs WHERE id = ?")
        .get(attempt.entity_id)?.cohort_id;
      if (cohortId) clearEntity("cohorts", cohortId);
      break;
    }
  }
}
