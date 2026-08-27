-- The execution attempt that emitted each revision.
--
-- A unit relaunched onto a revised input is a later attempt of the same
-- execution. Its output supersedes what the earlier attempt released, where
-- the earlier attempt's own re-emission is refused. Rows from before this
-- column carry no attempt and keep the older rule: released is final.
ALTER TABLE oakridge.artifact ADD COLUMN attempt_workflow_id text;

-- Released is no longer terminal: a later attempt supersedes what an earlier
-- one released. The superseded row keeps `released_at` — the release happened,
-- and the waits that were decided against it still cite it.
ALTER TABLE oakridge.artifact DROP CONSTRAINT artifact_lifecycle_shape;
ALTER TABLE oakridge.artifact
  ADD CONSTRAINT artifact_lifecycle_shape CHECK (
    (lifecycle_state = 'current' AND superseded_by_artifact_id IS NULL AND superseded_at IS NULL AND withdrawn_actor IS NULL AND withdrawn_reason IS NULL AND withdrawn_at IS NULL AND released_at IS NULL)
    OR (lifecycle_state = 'superseded' AND superseded_by_artifact_id IS NOT NULL AND superseded_at IS NOT NULL AND withdrawn_actor IS NULL AND withdrawn_reason IS NULL AND withdrawn_at IS NULL)
    OR (lifecycle_state = 'withdrawn' AND superseded_by_artifact_id IS NULL AND superseded_at IS NULL AND withdrawn_actor IS NOT NULL AND withdrawn_reason IS NOT NULL AND withdrawn_at IS NOT NULL AND released_at IS NULL)
    OR (lifecycle_state = 'released' AND superseded_by_artifact_id IS NULL AND superseded_at IS NULL AND withdrawn_actor IS NULL AND withdrawn_reason IS NULL AND withdrawn_at IS NULL AND released_at IS NOT NULL)
  );
