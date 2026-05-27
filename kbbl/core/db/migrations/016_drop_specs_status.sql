-- Drop specs.status column via SQLite 12-step table-rebuild.
-- Epic.status + specs.internal_status fully cover it.
-- Mirror pattern from migration 010.
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
    CHECK (current_session_stage IS NULL OR current_session_stage IN ('planner0','planner1','planner2','planner2_batch','planner3','build')),
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
