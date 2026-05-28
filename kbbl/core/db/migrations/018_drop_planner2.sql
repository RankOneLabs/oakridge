-- Remove the dead planner2 stage. planner2 was never dispatched in the live
-- code path; planner2_batch is the live brief-writer and is unrelated.
-- 1. Delete the stages row.
-- 2. NULL-out any orphaned current_session_stage rows on specs and cohorts.
-- 3. Rebuild specs and cohorts to drop planner2 from CHECK whitelists.
--    New whitelist: (planner0, planner1, planner2_batch, planner3, build).
-- Mirror pattern from migration 010/016.

DELETE FROM stages WHERE name = 'planner2';

UPDATE specs   SET current_session_stage = NULL WHERE current_session_stage = 'planner2';
UPDATE cohorts SET current_session_stage = NULL WHERE current_session_stage = 'planner2';

-- Rebuild specs table.
COMMIT;
PRAGMA foreign_keys = OFF;
BEGIN;
CREATE TABLE specs_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  current_session_ref TEXT,
  current_session_stage TEXT
    CHECK (current_session_stage IS NULL OR current_session_stage IN ('planner0','planner1','planner2_batch','planner3','build')),
  submitted_notes TEXT,
  final_notes TEXT,
  internal_status TEXT NOT NULL DEFAULT 'analyzing'
    CHECK (internal_status IN ('analyzing', 'discrepancies', 'review', 'approved'))
);
INSERT INTO specs_new
  SELECT id, project_id, title, notes, created_at,
         current_session_ref, current_session_stage,
         submitted_notes, final_notes, internal_status
  FROM specs;
DROP INDEX specs_project_id;
DROP TABLE specs;
ALTER TABLE specs_new RENAME TO specs;
CREATE INDEX specs_project_id ON specs(project_id);
COMMIT;
PRAGMA foreign_keys = ON;
BEGIN;

-- Rebuild cohorts table.
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
    CHECK (current_session_stage IS NULL OR current_session_stage IN ('planner0','planner1','planner2_batch','planner3','build'))
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
