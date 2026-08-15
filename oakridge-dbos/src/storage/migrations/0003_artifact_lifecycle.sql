DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM oakridge.artifact) THEN
    RAISE EXCEPTION '0003_artifact_lifecycle requires an empty spike artifact table; reset spike data before migration because prior releases cannot be inferred safely';
  END IF;
END $$;

ALTER TABLE oakridge.artifact
  ADD COLUMN lifecycle_state text NOT NULL DEFAULT 'current',
  ADD COLUMN superseded_by_artifact_id uuid REFERENCES oakridge.artifact(id),
  ADD COLUMN superseded_at timestamptz,
  ADD COLUMN withdrawn_actor text,
  ADD COLUMN withdrawn_reason text,
  ADD COLUMN withdrawn_at timestamptz,
  ADD COLUMN released_at timestamptz,
  ADD COLUMN lifecycle_updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN effective_slot boolean GENERATED ALWAYS AS (
    CASE WHEN lifecycle_state IN ('current', 'released') THEN true ELSE NULL END
  ) STORED;

ALTER TABLE oakridge.artifact
  ADD CONSTRAINT artifact_lifecycle_state CHECK (lifecycle_state IN ('current', 'superseded', 'withdrawn', 'released')),
  ADD CONSTRAINT artifact_lifecycle_shape CHECK (
    (lifecycle_state = 'current' AND superseded_by_artifact_id IS NULL AND superseded_at IS NULL AND withdrawn_actor IS NULL AND withdrawn_reason IS NULL AND withdrawn_at IS NULL AND released_at IS NULL)
    OR (lifecycle_state = 'superseded' AND superseded_by_artifact_id IS NOT NULL AND superseded_at IS NOT NULL AND withdrawn_actor IS NULL AND withdrawn_reason IS NULL AND withdrawn_at IS NULL AND released_at IS NULL)
    OR (lifecycle_state = 'withdrawn' AND superseded_by_artifact_id IS NULL AND superseded_at IS NULL AND withdrawn_actor IS NOT NULL AND withdrawn_reason IS NOT NULL AND withdrawn_at IS NOT NULL AND released_at IS NULL)
    OR (lifecycle_state = 'released' AND superseded_by_artifact_id IS NULL AND superseded_at IS NULL AND withdrawn_actor IS NULL AND withdrawn_reason IS NULL AND withdrawn_at IS NULL AND released_at IS NOT NULL)
  );

ALTER TABLE oakridge.artifact
  ADD CONSTRAINT artifact_one_effective_revision UNIQUE
    (stage_instance_id, execution_id, unit_id, output_name, effective_slot)
    DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX artifact_linear_revision_parent
  ON oakridge.artifact (parent_artifact_id)
  WHERE parent_artifact_id IS NOT NULL;

CREATE FUNCTION oakridge.validate_artifact_revision_link()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent oakridge.artifact%ROWTYPE;
  child oakridge.artifact%ROWTYPE;
BEGIN
  IF NEW.parent_artifact_id IS NOT NULL THEN
    SELECT * INTO parent FROM oakridge.artifact WHERE id = NEW.parent_artifact_id;
    IF NOT FOUND
       OR parent.run_id <> NEW.run_id
       OR parent.stage_instance_id <> NEW.stage_instance_id
       OR parent.execution_id <> NEW.execution_id
       OR parent.unit_id <> NEW.unit_id
       OR parent.output_name <> NEW.output_name
       OR parent.artifact_type <> NEW.artifact_type
       OR parent.version + 1 <> NEW.version THEN
      RAISE EXCEPTION 'artifact % has an invalid parent revision link', NEW.id;
    END IF;
    IF parent.lifecycle_state = 'superseded' AND parent.superseded_by_artifact_id <> NEW.id THEN
      RAISE EXCEPTION 'artifact % does not match superseded parent %', NEW.id, parent.id;
    END IF;
  END IF;
  IF NEW.lifecycle_state = 'superseded' THEN
    SELECT * INTO child FROM oakridge.artifact WHERE parent_artifact_id = NEW.id;
    IF NOT FOUND OR NEW.superseded_by_artifact_id <> child.id THEN
      RAISE EXCEPTION 'superseded artifact % does not identify its child revision', NEW.id;
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER artifact_revision_link_is_valid
AFTER INSERT OR UPDATE OF lifecycle_state, superseded_by_artifact_id, parent_artifact_id
ON oakridge.artifact
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION oakridge.validate_artifact_revision_link();

CREATE INDEX artifact_run_lifecycle
  ON oakridge.artifact (run_id, lifecycle_state);

CREATE TABLE oakridge.artifact_emission_idempotency (
  stage_instance_id uuid NOT NULL,
  execution_id text NOT NULL,
  unit_id text NOT NULL,
  output_name text NOT NULL,
  idempotency_key text NOT NULL,
  payload_hash text NOT NULL,
  artifact_id uuid NOT NULL REFERENCES oakridge.artifact(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (stage_instance_id, execution_id, unit_id, output_name, idempotency_key)
);

INSERT INTO oakridge.artifact_emission_idempotency
  (stage_instance_id, execution_id, unit_id, output_name, idempotency_key, payload_hash, artifact_id, created_at)
SELECT stage_instance_id, execution_id, unit_id, output_name,
       emission_idempotency_key, emission_payload_hash, id, created_at
FROM oakridge.artifact;

ALTER TABLE oakridge.command_outbox
  ADD COLUMN sequence_id bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN claimed_by text,
  ADD COLUMN claimed_until timestamptz,
  ADD COLUMN last_error text,
  ADD CONSTRAINT command_outbox_claim_shape CHECK ((claimed_by IS NULL) = (claimed_until IS NULL));
