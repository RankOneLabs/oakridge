-- 0014 made NULL collection keys compare equal, but also made the NULL
-- effective_slot on historical revisions compare equal. That accidentally
-- permits only one superseded/withdrawn revision per output coordinate.
-- Historical rows use their own identity; current/released rows still share
-- one deferred uniqueness slot, including scalar (NULL collection key) outputs.
ALTER TABLE oakridge.artifact
  ADD COLUMN historical_revision_id uuid GENERATED ALWAYS AS (
    CASE WHEN lifecycle_state IN ('current', 'released') THEN NULL ELSE id END
  ) STORED;

ALTER TABLE oakridge.artifact DROP CONSTRAINT artifact_one_effective_revision;
ALTER TABLE oakridge.artifact
  ADD CONSTRAINT artifact_one_effective_revision
  UNIQUE NULLS NOT DISTINCT
    (stage_instance_id, execution_id, unit_id, output_name, collection_key, effective_slot, historical_revision_id)
  DEFERRABLE INITIALLY DEFERRED;
