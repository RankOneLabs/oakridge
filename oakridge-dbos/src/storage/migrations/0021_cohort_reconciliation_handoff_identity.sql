-- Existing rows have no trustworthy artifact identity: the current slot may
-- already point at a replacement handoff, so leave them null until observed.
ALTER TABLE oakridge.cohort_pull_request_reconciliation
  ADD COLUMN handoff_artifact_id uuid REFERENCES oakridge.artifact(id) ON DELETE SET NULL;
