-- no-transaction
-- Rebuild the run-owned tables with explicit delete behavior and uniqueness
-- constraints. This keeps migration history additive while hardening the live
-- schema for future writes.
--
-- Artifact revisions are run-owned. parent_artifact_id cascades so deleting an
-- artifact revision removes its descendant revisions, and deleting a workflow
-- run removes the full artifact tree without a separate traversal.

CREATE TEMP TABLE migration_0004_preflight (
    ok INTEGER NOT NULL CHECK (ok = 1)
);

INSERT INTO migration_0004_preflight (ok)
SELECT 0
FROM pragma_foreign_key_check
LIMIT 1;

INSERT INTO migration_0004_preflight (ok)
SELECT 0
FROM (
    SELECT run_id, stage_key
    FROM stage_instance
    GROUP BY run_id, stage_key
    HAVING COUNT(*) > 1
)
LIMIT 1;

INSERT INTO migration_0004_preflight (ok)
SELECT 0
FROM (
    SELECT parent_artifact_id, version
    FROM artifact
    WHERE parent_artifact_id IS NOT NULL
    GROUP BY parent_artifact_id, version
    HAVING COUNT(*) > 1
)
LIMIT 1;

DROP TABLE migration_0004_preflight;

PRAGMA foreign_keys = OFF;

ALTER TABLE artifact RENAME TO artifact_old;
ALTER TABLE stage_instance RENAME TO stage_instance_old;
ALTER TABLE workflow_run RENAME TO workflow_run_old;

CREATE TABLE workflow_run (
    id TEXT NOT NULL PRIMARY KEY,
    workflow_def_id TEXT NOT NULL REFERENCES workflow_def(id) ON DELETE RESTRICT,
    project_id TEXT REFERENCES project(id) ON DELETE RESTRICT,
    status TEXT NOT NULL CHECK (status IN ('pending','running','done','failed')),
    context TEXT,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO workflow_run (
    id, workflow_def_id, project_id, status, context, version, created_at, updated_at
)
SELECT
    id, workflow_def_id, project_id, status, context, version, created_at, updated_at
FROM workflow_run_old;

CREATE TABLE stage_instance (
    id TEXT NOT NULL PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
    stage_key TEXT NOT NULL,
    stage_type TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','running','parked','done','failed')),
    config TEXT NOT NULL,
    parked_reason TEXT,
    external_ref TEXT,
    started_at TEXT,
    ended_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(run_id, stage_key)
);

INSERT INTO stage_instance (
    id, run_id, stage_key, stage_type, status, config, parked_reason, external_ref,
    started_at, ended_at, created_at, updated_at
)
SELECT
    id, run_id, stage_key, stage_type, status, config, parked_reason, external_ref,
    started_at, ended_at, created_at, updated_at
FROM stage_instance_old;

CREATE TABLE artifact (
    id TEXT NOT NULL PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
    stage_instance_id TEXT NOT NULL REFERENCES stage_instance(id) ON DELETE CASCADE,
    artifact_type TEXT NOT NULL,
    output_name TEXT,
    label TEXT,
    body TEXT NOT NULL,
    version INTEGER NOT NULL,
    parent_artifact_id TEXT REFERENCES artifact(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO artifact (
    id, run_id, stage_instance_id, artifact_type, output_name, label, body, version,
    parent_artifact_id, created_at
)
SELECT
    id, run_id, stage_instance_id, artifact_type, output_name, label, body, version,
    parent_artifact_id, created_at
FROM artifact_old
ORDER BY parent_artifact_id IS NULL DESC, created_at, id;

DROP TABLE artifact_old;
DROP TABLE stage_instance_old;
DROP TABLE workflow_run_old;

CREATE INDEX workflow_run_status ON workflow_run(status);
CREATE INDEX workflow_run_project ON workflow_run(project_id);
CREATE INDEX stage_instance_run ON stage_instance(run_id);
CREATE INDEX stage_instance_status ON stage_instance(status);
CREATE INDEX artifact_run_type ON artifact(run_id, artifact_type);
CREATE INDEX artifact_producer ON artifact(stage_instance_id);
CREATE UNIQUE INDEX artifact_parent_version_unique
    ON artifact(parent_artifact_id, version)
    WHERE parent_artifact_id IS NOT NULL;

PRAGMA foreign_keys = ON;
