ALTER TABLE epics
  ADD COLUMN agent_runtime TEXT NOT NULL DEFAULT 'claude-code'
  CHECK (agent_runtime IN ('claude-code', 'codex'));
