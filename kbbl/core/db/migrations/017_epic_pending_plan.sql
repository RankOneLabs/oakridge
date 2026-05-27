-- Extend Epic.status to include 'pending' (initial state before first gate crossing)
-- and Epic.current_stage to include 'plan' (between spec approval and plan approval).
-- SQLite cannot ALTER CHECK constraints, so recreate the table.

PRAGMA foreign_keys = OFF;

CREATE TABLE epics_new (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL UNIQUE REFERENCES specs(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'complete', 'archived')),
  current_stage TEXT NOT NULL CHECK (current_stage IN ('spec', 'plan', 'build', 'review')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO epics_new SELECT * FROM epics;

DROP TABLE epics;
ALTER TABLE epics_new RENAME TO epics;

CREATE INDEX epics_project_id_status ON epics(project_id, status);

PRAGMA foreign_keys = ON;
