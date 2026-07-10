-- Phase 4a: run lifecycle — archived flag on workflow_run.
-- Archived is orthogonal to run status: a complete or failed run can be archived
-- and retains its terminal status. Default 0 (not archived).
ALTER TABLE workflow_run ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS workflow_run_archived ON workflow_run(archived);
