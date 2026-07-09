-- Phase 2a: per-unit session state for multi-session stages.
-- Each stage_instance owns one or more units (N=1 is the implicit single-session path).
-- ON DELETE CASCADE keeps deletion a single transaction.
CREATE TABLE IF NOT EXISTS stage_session_units (
    stage_instance_id TEXT NOT NULL
        REFERENCES stage_instance(id) ON DELETE CASCADE,
    unit_id TEXT NOT NULL,
    params TEXT,            -- JSON blob; null for implicit N=1 unit
    depends_on TEXT NOT NULL DEFAULT '[]',  -- JSON array of unit_id strings
    external_ref TEXT,      -- kbbl session id (DelegatedExternalRef JSON)
    worktree_branch TEXT,
    worktree_path TEXT,
    worktree_base_ref TEXT,
    status TEXT NOT NULL
        CHECK(status IN ('pending', 'running', 'parked', 'done', 'failed')),
    gate_state TEXT,        -- JSON; mirrors stage_instance.parked_meta for N=1
    artifact_id TEXT,       -- UUID string of the emitted artifact
    terminal_meta TEXT,     -- JSON
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (stage_instance_id, unit_id)
);
