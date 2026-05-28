-- Rename EpicStage 'review' → 'assess' and planner3 → assessor.
-- These are the same conceptual unit (the stage that runs the assessor agent);
-- bundling keeps the sessions CHECK rebuild to one occurrence.
--
-- 1. Rename planner3 stage row (name + prompt_template_path).
-- 2. Update plans.current_session_stage (no DB CHECK — safe to UPDATE directly).
-- 3. Rebuild epics table: rename current_stage 'review'→'assess', update CHECK.
-- 4. Rebuild specs table: update CHECK whitelist (planner3→assessor).
-- 5. Rebuild cohorts table: update CHECK whitelist (planner3→assessor).
-- Mirror table-recreate pattern from migrations 018/019.
-- Rollback order: reverse DB migration first, then git revert code commits.

UPDATE stages SET name = 'assessor', prompt_template_path = 'assessor.md' WHERE name = 'planner3';

-- plans has no DB CHECK on current_session_stage (migration 010), so direct UPDATE is safe.
UPDATE plans SET current_session_stage = 'assessor' WHERE current_session_stage = 'planner3';

-- Rebuild epics table: rename 'review'→'assess' in current_stage, update CHECK.
COMMIT;
PRAGMA foreign_keys = OFF;
BEGIN;
CREATE TABLE epics_new (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL UNIQUE REFERENCES specs(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'complete', 'archived')),
  current_stage TEXT NOT NULL CHECK (current_stage IN ('spec', 'plan', 'build', 'assess')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO epics_new
  SELECT id, spec_id, project_id, title, status,
         CASE current_stage WHEN 'review' THEN 'assess' ELSE current_stage END,
         created_at
  FROM epics;
DROP INDEX epics_project_id_status;
DROP TABLE epics;
ALTER TABLE epics_new RENAME TO epics;
CREATE INDEX epics_project_id_status ON epics(project_id, status);
COMMIT;
PRAGMA foreign_keys = ON;
BEGIN;

-- Rebuild specs table: update CHECK whitelist (planner3→assessor).
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
    CHECK (current_session_stage IS NULL OR current_session_stage IN ('spec_analyzer','plan_writer','brief_writer','assessor','build')),
  submitted_notes TEXT,
  final_notes TEXT,
  internal_status TEXT NOT NULL DEFAULT 'analyzing'
    CHECK (internal_status IN ('analyzing', 'discrepancies', 'review', 'approved'))
);
INSERT INTO specs_new
  SELECT id, project_id, title, notes, created_at,
         current_session_ref,
         CASE current_session_stage WHEN 'planner3' THEN 'assessor' ELSE current_session_stage END,
         submitted_notes, final_notes, internal_status
  FROM specs;
DROP INDEX specs_project_id;
DROP TABLE specs;
ALTER TABLE specs_new RENAME TO specs;
CREATE INDEX specs_project_id ON specs(project_id);
COMMIT;
PRAGMA foreign_keys = ON;
BEGIN;

-- Rebuild cohorts table: update CHECK whitelist (planner3→assessor).
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
    CHECK (current_session_stage IS NULL OR current_session_stage IN ('spec_analyzer','plan_writer','brief_writer','assessor','build'))
);
INSERT INTO cohorts_new
  SELECT id, plan_id, title, notes, position, status, created_at,
         pre_block_status, current_session_ref,
         CASE current_session_stage WHEN 'planner3' THEN 'assessor' ELSE current_session_stage END
  FROM cohorts;
DROP INDEX cohorts_plan_id;
DROP TABLE cohorts;
ALTER TABLE cohorts_new RENAME TO cohorts;
CREATE INDEX cohorts_plan_id ON cohorts(plan_id);
COMMIT;
PRAGMA foreign_keys = ON;
BEGIN;
