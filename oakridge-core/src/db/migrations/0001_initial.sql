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
    workflow_def_id TEXT NOT NULL REFERENCES workflow_def(id),
    project_id TEXT REFERENCES project(id),
    status TEXT NOT NULL CHECK (status IN ('pending','running','done','failed')),
    context TEXT,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS stage_instance (
    id TEXT NOT NULL PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES workflow_run(id),
    stage_key TEXT NOT NULL,
    stage_type TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','running','parked','done','failed')),
    config TEXT NOT NULL,
    parked_reason TEXT,
    external_ref TEXT,
    started_at TEXT,
    ended_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS artifact (
    id TEXT NOT NULL PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES workflow_run(id),
    stage_instance_id TEXT NOT NULL REFERENCES stage_instance(id),
    artifact_type TEXT NOT NULL,
    label TEXT,
    body TEXT NOT NULL,
    parent_artifact_id TEXT REFERENCES artifact(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS workflow_run_status ON workflow_run(status);
CREATE INDEX IF NOT EXISTS workflow_run_project ON workflow_run(project_id);
CREATE INDEX IF NOT EXISTS stage_instance_run ON stage_instance(run_id);
CREATE INDEX IF NOT EXISTS stage_instance_status ON stage_instance(status);
CREATE INDEX IF NOT EXISTS stage_instance_run_key ON stage_instance(run_id, stage_key);
CREATE INDEX IF NOT EXISTS artifact_run_type ON artifact(run_id, artifact_type);
CREATE INDEX IF NOT EXISTS artifact_producer ON artifact(stage_instance_id);
