-- Initial oakridge-core schema.
--
-- oakridge-core has no persistent deployment yet, so the prior migration chain
-- (initial + artifact output_name + artifact version + SQLite hardening + stage
-- parked_meta) was collapsed into this single initial migration. It produces the
-- exact same final schema. Add future schema changes as new additive migrations.

CREATE TABLE IF NOT EXISTS project (
    id TEXT NOT NULL PRIMARY KEY,
    name TEXT NOT NULL,
    repo_dir TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS workflow_def (
    id TEXT NOT NULL PRIMARY KEY,
    name TEXT NOT NULL,
    version INTEGER NOT NULL,
    graph TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(name, version)
);

CREATE TABLE IF NOT EXISTS workflow_run (
    id TEXT NOT NULL PRIMARY KEY,
    workflow_def_id TEXT NOT NULL REFERENCES workflow_def(id) ON DELETE RESTRICT,
    project_id TEXT REFERENCES project(id) ON DELETE RESTRICT,
    status TEXT NOT NULL CHECK (status IN ('pending','running','done','failed')),
    context TEXT,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS stage_instance (
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
    -- Structured park metadata attached by an executor while a stage is parked
    -- (e.g. the session_agent approval request_id). JSON-encoded, nullable.
    parked_meta TEXT,
    UNIQUE(run_id, stage_key)
);

CREATE TABLE IF NOT EXISTS artifact (
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

CREATE INDEX IF NOT EXISTS workflow_run_status ON workflow_run(status);
CREATE INDEX IF NOT EXISTS workflow_run_project ON workflow_run(project_id);
CREATE INDEX IF NOT EXISTS stage_instance_run ON stage_instance(run_id);
CREATE INDEX IF NOT EXISTS stage_instance_status ON stage_instance(status);
CREATE INDEX IF NOT EXISTS artifact_run_type ON artifact(run_id, artifact_type);
CREATE INDEX IF NOT EXISTS artifact_producer ON artifact(stage_instance_id);
CREATE UNIQUE INDEX IF NOT EXISTS artifact_parent_version_unique
    ON artifact(parent_artifact_id, version)
    WHERE parent_artifact_id IS NOT NULL;
