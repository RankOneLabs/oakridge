-- Remove the pre-split single-runtime column from databases that already
-- applied migrations 021 and 023 before split-model cleanup.
-- kbbl:disable_foreign_keys

CREATE TABLE epics_new (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL UNIQUE REFERENCES specs(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'complete', 'archived')),
  current_stage TEXT NOT NULL CHECK (current_stage IN ('spec', 'plan', 'build', 'assess')),
  planner_runtime TEXT NOT NULL CHECK (planner_runtime IN ('claude-code', 'codex')),
  planner_model TEXT NOT NULL CHECK (length(trim(planner_model)) > 0),
  worker_runtime TEXT NOT NULL CHECK (worker_runtime IN ('claude-code', 'codex')),
  worker_model TEXT NOT NULL CHECK (length(trim(worker_model)) > 0),
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
  planner_runtime,
  planner_model,
  worker_runtime,
  worker_model,
  created_at
FROM epics;

DROP INDEX epics_project_id_status;
DROP TABLE epics;
ALTER TABLE epics_new RENAME TO epics;
CREATE INDEX epics_project_id_status ON epics(project_id, status);
