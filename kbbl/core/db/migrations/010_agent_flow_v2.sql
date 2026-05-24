-- Add current_session_ref and current_session_stage to plans table.
-- plans.current_session_stage is intentionally left without a DB CHECK; Zod
-- SessionStageSchema enforces the union at the application layer so cohorts 2
-- and 4 can extend the allowed stage values without a schema rewrite here.
-- (cohorts.current_session_stage retains its existing CHECK from migration 009
-- and is reproduced verbatim in the table rebuild below.)
ALTER TABLE plans ADD COLUMN current_session_ref TEXT;
ALTER TABLE plans ADD COLUMN current_session_stage TEXT;

-- Widen cohorts.status CHECK to include ready_to_build and awaiting_merge.
-- bun:sqlite disables PRAGMA writable_schema, so we use the 12-step table-rebuild
-- instead. PRAGMA foreign_keys=OFF must be set in autocommit mode; we COMMIT
-- the runner's outer transaction, do the rebuild, then BEGIN so the runner can
-- record the migration normally.
COMMIT;
PRAGMA foreign_keys = OFF;
BEGIN;
CREATE TABLE cohorts_new (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  title TEXT NOT NULL,
  notes TEXT,
  position INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting','planned','briefing','brief_review','building','ready_to_build','awaiting_merge','done','blocked')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  pre_block_status TEXT,
  current_session_ref TEXT,
  current_session_stage TEXT
    CHECK (current_session_stage IS NULL OR current_session_stage IN ('planner1','planner2','build'))
);
INSERT INTO cohorts_new
  SELECT id, plan_id, title, notes, position, status, created_at,
         pre_block_status, current_session_ref, current_session_stage
  FROM cohorts;
DROP INDEX cohorts_plan_id;
DROP TABLE cohorts;
ALTER TABLE cohorts_new RENAME TO cohorts;
CREATE INDEX cohorts_plan_id ON cohorts(plan_id);
COMMIT;
PRAGMA foreign_keys = ON;
BEGIN;
