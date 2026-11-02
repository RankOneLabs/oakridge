-- Place each assessment revision in the run's decision history. New rows
-- carry the exact cursor from the evaluator; completed historical runs are
-- read-only and are backfilled from the persisted write timestamps.
ALTER TABLE authority.artifact_revision
  ADD COLUMN decision_cursor integer NOT NULL DEFAULT 0;

UPDATE authority.artifact_revision AS revision
SET decision_cursor = (
  SELECT count(*)::integer
  FROM authority.review_decision AS decision
  WHERE decision.run_id = revision.run_id
    AND decision.created_at < revision.created_at
);
