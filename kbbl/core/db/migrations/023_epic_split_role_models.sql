-- Persist split model selections on epics.
-- Each epic stores a planner selection and a worker selection.
--
-- Backfill existing epics from the temporary pre-split runtime source:
--   planner.runtime = agent_runtime
--   worker.runtime  = agent_runtime
--   planner.model   = current planner-grade default for that runtime
--   worker.model    = current build-grade default for that runtime
--
-- SQLite requires a table rebuild to add CHECK constraints and keep the
-- migration deterministic for existing rows.

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
  planner_runtime TEXT NOT NULL CHECK (planner_runtime IN ('claude-code', 'codex')),
  planner_model TEXT NOT NULL,
  worker_runtime TEXT NOT NULL CHECK (worker_runtime IN ('claude-code', 'codex')),
  worker_model TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO epics_new (
  id,
  spec_id,
  project_id,
  title,
  status,
  current_stage,
  planner_runtime,
  planner_model,
  worker_runtime,
  worker_model,
  created_at
)
SELECT
  id,
  spec_id,
  project_id,
  title,
  status,
  current_stage,
  agent_runtime,
  CASE agent_runtime
    WHEN 'codex' THEN 'gpt-5.5'
    ELSE 'claude-opus-4-8'
  END,
  agent_runtime,
  CASE agent_runtime
    WHEN 'codex' THEN 'gpt-5.4-mini'
    ELSE 'claude-sonnet-4-6'
  END,
  created_at
FROM epics;

DROP INDEX epics_project_id_status;
DROP TABLE epics;
ALTER TABLE epics_new RENAME TO epics;
CREATE INDEX epics_project_id_status ON epics(project_id, status);

COMMIT;
PRAGMA foreign_keys = ON;
BEGIN;
