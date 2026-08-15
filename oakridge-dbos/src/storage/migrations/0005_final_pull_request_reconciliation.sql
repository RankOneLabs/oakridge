CREATE TABLE oakridge.final_pull_request_reconciliation (
  epic_profile_id uuid NOT NULL REFERENCES oakridge.epic_workflow_profile(id) ON DELETE CASCADE,
  repository_key text NOT NULL CHECK (length(btrim(repository_key)) > 0),
  observation jsonb NOT NULL,
  mismatch jsonb,
  observed_at timestamptz NOT NULL,
  merged_evidence_at timestamptz,
  confirmation_idempotency_key text,
  operator_comment text,
  confirmed_at timestamptz,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (epic_profile_id, repository_key),
  CHECK ((confirmation_idempotency_key IS NULL) = (confirmed_at IS NULL)),
  CHECK (confirmation_idempotency_key IS NULL OR length(btrim(confirmation_idempotency_key)) > 0)
);

CREATE UNIQUE INDEX final_pull_request_confirmation_key
  ON oakridge.final_pull_request_reconciliation (epic_profile_id, confirmation_idempotency_key)
  WHERE confirmation_idempotency_key IS NOT NULL;

ALTER TABLE oakridge.cohort_pull_request_reconciliation
  ADD COLUMN observed_at timestamptz;

UPDATE oakridge.cohort_pull_request_reconciliation
SET observed_at = (observation->>'observed_at')::timestamptz;

ALTER TABLE oakridge.cohort_pull_request_reconciliation
  ALTER COLUMN observed_at SET NOT NULL;
