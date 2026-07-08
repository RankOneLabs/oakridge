-- Durable dispatch ledger: records every builder/spec/plan/brief/assessor
-- dispatch attempt before session spawn. The partial unique index on
-- (entity_kind, entity_id, stage) WHERE status IN ('dispatching','running')
-- enforces at most one active claim per logical entity/stage pair, closing
-- hook-vs-click and double-POST races across awaited git and session ops.

CREATE TABLE dispatch_attempts (
  id                     TEXT PRIMARY KEY,
  entity_kind            TEXT NOT NULL
    CHECK (entity_kind IN ('spec', 'cohort', 'brief', 'plan')),
  entity_id              TEXT NOT NULL,
  stage                  TEXT NOT NULL,
  epic_id                TEXT,
  cohort_id              TEXT,
  attempt_number         INTEGER NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'dispatching'
    CHECK (status IN ('dispatching', 'running', 'dispatch_failed', 'succeeded', 'cancelled')),
  intended_session_ref   TEXT,
  actual_session_ref     TEXT,
  branch_name            TEXT,
  worktree_path          TEXT,
  predecessor_attempt_id TEXT REFERENCES dispatch_attempts(id),
  last_error             TEXT,
  recovery_hint          TEXT,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Only one dispatching-or-running attempt per logical entity/stage at a time.
-- SQLite partial index with OR is supported since SQLite 3.8.0.
CREATE UNIQUE INDEX dispatch_attempts_active_claim
  ON dispatch_attempts (entity_kind, entity_id, stage)
  WHERE status = 'dispatching' OR status = 'running';
