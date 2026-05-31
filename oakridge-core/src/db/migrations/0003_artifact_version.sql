-- Artifact revision number. Root artifacts are version 1; a revision emitted with
-- a parent_artifact_id gets parent.version + 1. Existing rows default to 1.
ALTER TABLE artifact ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
