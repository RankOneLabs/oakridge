-- Durable terminal-session fallback. This is deliberately not a transcript:
-- one compact final response/handoff is retained so an ended session remains
-- useful when the agent can no longer satisfy ACP session/load.

CREATE TABLE acp_session_summaries (
  sid TEXT PRIMARY KEY REFERENCES acp_sessions(sid) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  method TEXT NOT NULL CHECK (method IN (
    'native_compaction',
    'manual_compaction',
    'final_response'
  )),
  summary_json TEXT NOT NULL,
  produced_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
