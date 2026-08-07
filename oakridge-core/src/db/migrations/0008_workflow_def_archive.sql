-- Retire superseded workflow definitions without losing run history.
--
-- Mirrors the run-archive flag in 0006. Archiving is orthogonal to identity: an
-- archived def keeps its id, so every workflow_run that references it still
-- resolves. Deleting is not the alternative — workflow_run.workflow_def_id is
-- ON DELETE RESTRICT, so any def with runs cannot be removed at all.
--
-- Default 0 (active) so existing rows keep showing up until something retires them.
ALTER TABLE workflow_def ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS workflow_def_archived ON workflow_def(archived);
