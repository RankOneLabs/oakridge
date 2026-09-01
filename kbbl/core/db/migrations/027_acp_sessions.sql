-- ACP session metadata + turn ledger (migration spec §9). Replaces the
-- filesystem claim JSON / input-receipt JSON used by the legacy resumable
-- session flow with durable SQLite rows, so DBOS resumability and
-- delivery-key idempotency survive kbbl restarts without a transcript
-- store (the agent owns conversation history; kbbl stores only the opaque
-- acp_session_id pointer).
--
-- acp_turns is NOT a second agent state machine: it is an idempotency and
-- execution-outcome ledger. One row per (sid, turn_key); same key + same
-- payload_hash returns the prior receipt, same key + different hash is a
-- 409. Status ordering rule (§10.7): a turn is flipped to 'prompting' in
-- its own transaction BEFORE session/prompt is sent, so after a kbbl crash
-- 'accepted' provably never reached an agent while 'prompting' may have.

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

  status TEXT NOT NULL CHECK (status IN (
    'provisioning',
    'idle',
    'prompting',
    'ended',
    'fenced',
    'failed',
    'unknown'
  )),

  end_reason TEXT,
  fenced_by TEXT,
  last_activity_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX acp_sessions_updated_idx ON acp_sessions(updated_at DESC);
CREATE INDEX acp_sessions_artifact_idx ON acp_sessions(artifact_id);

CREATE TABLE acp_turns (
  sid TEXT NOT NULL REFERENCES acp_sessions(sid) ON DELETE CASCADE,
  turn_key TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('initial', 'operator', 'collaboration')),
  payload_hash TEXT NOT NULL,
  -- The user input text for this turn. Required so a turn retained in
  -- 'accepted' across a kbbl restart can still be dispatched exactly once
  -- (§10.7); the §9.3 prohibition covers assistant transcript content,
  -- which never lands in this table.
  payload TEXT NOT NULL,
  user_message_id TEXT,

  status TEXT NOT NULL CHECK (status IN (
    'accepted',
    'prompting',
    'succeeded',
    'cancelled',
    'failed',
    'unknown'
  )),

  stop_reason TEXT,
  failure_code TEXT,
  failure_detail TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,

  PRIMARY KEY (sid, turn_key)
);
