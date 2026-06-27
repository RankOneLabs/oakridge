-- Temporary pre-split runtime source used only by migration 023.
-- The rebuilt split-model schema does not retain this column.
ALTER TABLE epics
  ADD COLUMN agent_runtime TEXT NOT NULL DEFAULT 'claude-code'
  CHECK (agent_runtime IN ('claude-code', 'codex'));
