-- Rename planner0→spec_analyzer, planner1→plan_writer, planner2_batch→brief_writer.
-- planner3 is intentionally left; it ships with the assess-stage rename in PR 4.
-- 1. Update stages rows (name + prompt_template_path).
-- 2. Update plans.current_session_stage (no DB CHECK — safe to UPDATE directly).
-- 3. Rebuild specs and cohorts: the old CHECK whitelists block direct UPDATEs to
--    new names, so the rename is done inside the INSERT...SELECT via CASE.
--    New whitelist: (spec_analyzer, plan_writer, brief_writer, planner3, build).
-- Mirror pattern from migration 018.

UPDATE stages SET name = 'spec_analyzer', prompt_template_path = 'spec_analyzer.md' WHERE name = 'planner0';
UPDATE stages SET name = 'plan_writer',   prompt_template_path = 'plan_writer.md'   WHERE name = 'planner1';
UPDATE stages SET name = 'brief_writer',  prompt_template_path = 'brief_writer.md'  WHERE name = 'planner2_batch';

-- plans has no DB CHECK on current_session_stage (migration 010), so direct UPDATE is safe.
UPDATE plans   SET current_session_stage = 'spec_analyzer' WHERE current_session_stage = 'planner0';
UPDATE plans   SET current_session_stage = 'plan_writer'   WHERE current_session_stage = 'planner1';
UPDATE plans   SET current_session_stage = 'brief_writer'  WHERE current_session_stage = 'planner2_batch';

-- Rebuild specs table (rename done in INSERT...SELECT to avoid violating old CHECK).
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
    CHECK (current_session_stage IS NULL OR current_session_stage IN ('spec_analyzer','plan_writer','brief_writer','planner3','build')),
  submitted_notes TEXT,
  final_notes TEXT,
  internal_status TEXT NOT NULL DEFAULT 'analyzing'
    CHECK (internal_status IN ('analyzing', 'discrepancies', 'review', 'approved'))
);
INSERT INTO specs_new
  SELECT id, project_id, title, notes, created_at,
         current_session_ref,
         CASE current_session_stage
           WHEN 'planner0'      THEN 'spec_analyzer'
           WHEN 'planner1'      THEN 'plan_writer'
           WHEN 'planner2_batch' THEN 'brief_writer'
           ELSE current_session_stage
         END,
         submitted_notes, final_notes, internal_status
  FROM specs;
DROP INDEX specs_project_id;
DROP TABLE specs;
ALTER TABLE specs_new RENAME TO specs;
CREATE INDEX specs_project_id ON specs(project_id);
COMMIT;
PRAGMA foreign_keys = ON;
BEGIN;

-- Rebuild cohorts table (rename done in INSERT...SELECT to avoid violating old CHECK).
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
    CHECK (current_session_stage IS NULL OR current_session_stage IN ('spec_analyzer','plan_writer','brief_writer','planner3','build'))
);
INSERT INTO cohorts_new
  SELECT id, plan_id, title, notes, position, status, created_at,
         pre_block_status, current_session_ref,
         CASE current_session_stage
           WHEN 'planner0'      THEN 'spec_analyzer'
           WHEN 'planner1'      THEN 'plan_writer'
           WHEN 'planner2_batch' THEN 'brief_writer'
           ELSE current_session_stage
         END
  FROM cohorts;
DROP INDEX cohorts_plan_id;
DROP TABLE cohorts;
ALTER TABLE cohorts_new RENAME TO cohorts;
CREATE INDEX cohorts_plan_id ON cohorts(plan_id);
COMMIT;
PRAGMA foreign_keys = ON;
BEGIN;
