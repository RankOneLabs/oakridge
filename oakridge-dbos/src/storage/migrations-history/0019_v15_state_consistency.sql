-- The state machine owns cohort state; generic lifecycle is its checked projection.
ALTER TABLE oakridge.cohort ADD CONSTRAINT cohort_state_status_consistent CHECK (
  status::text = CASE state WHEN 'pending' THEN 'pending' WHEN 'complete' THEN 'complete'
    WHEN 'failed' THEN 'failed' WHEN 'cancelled' THEN 'cancelled' ELSE 'active' END
);

-- Historical revisions retain their last review metadata. Current output slots
-- must agree with their referenced artifact at transaction commit.
CREATE FUNCTION oakridge.validate_current_output_acceptance()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_artifact_id uuid;
BEGIN
  IF TG_TABLE_NAME='artifact' THEN current_artifact_id := NEW.id;
  ELSE current_artifact_id := NEW.artifact_id; END IF;
  IF EXISTS (SELECT 1 FROM oakridge.worker_output output JOIN oakridge.artifact artifact ON artifact.id=output.artifact_id
    WHERE output.artifact_id = current_artifact_id
      AND output.acceptance_state <> artifact.acceptance_state) THEN
    RAISE EXCEPTION 'current output and artifact acceptance disagree';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER worker_output_acceptance_consistent
AFTER INSERT OR UPDATE ON oakridge.worker_output DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION oakridge.validate_current_output_acceptance();
CREATE CONSTRAINT TRIGGER artifact_output_acceptance_consistent
AFTER UPDATE ON oakridge.artifact DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION oakridge.validate_current_output_acceptance();

-- Gates now belong to worker records and versioned operator request receipts.
DROP TABLE oakridge.wait_gate_artifact_revision;
DROP TABLE oakridge.wait_gate;
