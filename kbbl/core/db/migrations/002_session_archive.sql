-- Hiding a session from operator lists must retain its row and transcript.
CREATE TABLE acp_session_archives (
  sid TEXT PRIMARY KEY REFERENCES acp_sessions(sid) ON DELETE CASCADE,
  archived_at TEXT NOT NULL
);
