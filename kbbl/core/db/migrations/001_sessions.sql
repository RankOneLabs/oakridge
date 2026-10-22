-- kbbl's ledger: ACP sessions, their turns and their terminal summaries.
-- A delegated session records the Oakridge attempt it serves (run, unit and
-- worker); a hand-started session records none.

CREATE TABLE acp_sessions (
  sid TEXT PRIMARY KEY,
  resumable_key TEXT UNIQUE,
  start_spec_hash TEXT,
  agent_profile TEXT NOT NULL,
  -- Opaque agent-issued session id. Never parsed; never used to infer the
  -- provider or the worktree location.
  acp_session_id TEXT,
  name TEXT NOT NULL,
  artifact_id TEXT,
  project_workdir TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  worktree_branch TEXT,
  worktree_base_ref TEXT,
  parent_sid TEXT,
  requested_model TEXT,
  requested_effort TEXT,
  requested_mode TEXT,
  status TEXT NOT NULL CHECK (status IN ('provisioning', 'idle', 'prompting', 'ended', 'fenced', 'failed', 'unknown')),
  end_reason TEXT,
  end_detail TEXT,
  fenced_by TEXT,
  run_id TEXT,
  unit_id TEXT,
  worker TEXT,
  last_activity_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX acp_sessions_artifact_idx ON acp_sessions(artifact_id);
CREATE INDEX acp_sessions_unit_idx ON acp_sessions(run_id, unit_id);
CREATE INDEX acp_sessions_updated_idx ON acp_sessions(updated_at DESC);

CREATE TABLE acp_turns (
  sid TEXT NOT NULL REFERENCES acp_sessions(sid) ON DELETE CASCADE,
  turn_key TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('initial', 'operator', 'collaboration')),
  payload_hash TEXT NOT NULL,
  -- The user input text for this turn, so a turn retained in 'accepted'
  -- across a kbbl restart can still be dispatched exactly once (§10.7).
  -- Assistant transcript content never lands in this table.
  payload TEXT NOT NULL,
  user_message_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'prompting', 'succeeded', 'cancelled', 'failed', 'unknown')),
  stop_reason TEXT,
  failure_code TEXT,
  failure_detail TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  PRIMARY KEY (sid, turn_key)
);

CREATE TABLE acp_session_summaries (
  sid TEXT PRIMARY KEY REFERENCES acp_sessions(sid) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  method TEXT NOT NULL CHECK (method IN ('native_compaction', 'manual_compaction', 'final_response')),
  summary_json TEXT NOT NULL,
  produced_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
