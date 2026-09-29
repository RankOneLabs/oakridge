-- Oakridge v15 baseline.
--
-- This file is intentionally a baseline, not an upgrade. The cutover runbook
-- drops the application schema and DBOS system tables before it is applied.

CREATE SCHEMA oakridge;

CREATE TYPE oakridge.core_status AS ENUM
  ('pending', 'active', 'blocked', 'complete', 'failed', 'cancelled');
CREATE TYPE oakridge.blocked_reason AS ENUM
  ('dependency', 'gate', 'capacity', 'external', 'operator', 'retry');
CREATE TYPE oakridge.next_actor AS ENUM
  ('core', 'agent', 'service', 'operator', 'external');
CREATE TYPE oakridge.attempt_status AS ENUM
  ('pending', 'active', 'blocked', 'complete', 'failed', 'cancelled');
CREATE TYPE oakridge.session_status AS ENUM
  ('pending', 'active', 'blocked', 'complete', 'failed', 'cancelled');
CREATE TYPE oakridge.artifact_lifecycle AS ENUM
  ('current', 'superseded', 'withdrawn', 'released');
CREATE TYPE oakridge.artifact_provenance_kind AS ENUM
  ('stage_attempt', 'service_action', 'operator_action', 'import');
CREATE TYPE oakridge.wait_kind AS ENUM ('gate', 'handoff', 'external');
CREATE TYPE oakridge.wait_status AS ENUM ('open', 'closed', 'cancelled');
CREATE TYPE oakridge.transition_owner_kind AS ENUM ('run', 'stage_instance', 'cohort');
CREATE TYPE oakridge.transition_launch_reason AS ENUM
  ('initial', 'dependency_satisfied', 'artifact_accepted', 'gate_decided', 'operator', 'retry', 'recovery');
CREATE TYPE oakridge.message_party_kind AS ENUM ('core', 'agent', 'service', 'operator');
CREATE TYPE oakridge.delivery_status AS ENUM ('pending', 'delivered', 'failed');

CREATE TABLE oakridge.project (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  repo_dir text NOT NULL,
  forge_repository jsonb,
  integration_branch text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name)
);

CREATE TABLE oakridge.workflow_definition (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  definition jsonb NOT NULL,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, version)
);

CREATE TABLE oakridge.prompt_bundle (
  hash text PRIMARY KEY,
  version integer NOT NULL CHECK (version > 0),
  matrix jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oakridge.workflow_definition_prompt_bundle (
  workflow_definition_id uuid PRIMARY KEY REFERENCES oakridge.workflow_definition(id),
  prompt_bundle_hash text NOT NULL REFERENCES oakridge.prompt_bundle(hash)
);

CREATE TABLE oakridge.workflow_run (
  id uuid PRIMARY KEY,
  workflow_definition_id uuid NOT NULL REFERENCES oakridge.workflow_definition(id),
  project_id uuid REFERENCES oakridge.project(id),
  context jsonb NOT NULL,
  bundle_pin jsonb NOT NULL,
  status oakridge.core_status NOT NULL DEFAULT 'pending',
  blocked_reason oakridge.blocked_reason,
  next_actor oakridge.next_actor,
  outcome jsonb,
  record_version bigint NOT NULL DEFAULT 0 CHECK (record_version >= 0),
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at timestamptz,
  UNIQUE (id, record_version),
  CHECK ((status = 'blocked') = (blocked_reason IS NOT NULL)),
  CHECK ((status IN ('complete', 'failed', 'cancelled')) = (ended_at IS NOT NULL)),
  CHECK (status IN ('complete', 'failed', 'cancelled') OR outcome IS NULL)
);
CREATE INDEX workflow_run_status_idx ON oakridge.workflow_run (status, created_at);
CREATE INDEX workflow_run_archived_idx ON oakridge.workflow_run (archived);

CREATE TABLE oakridge.stage_instance (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES oakridge.workflow_run(id) ON DELETE CASCADE,
  stage_key text NOT NULL CHECK (length(btrim(stage_key)) > 0),
  stage_type text NOT NULL CHECK (length(btrim(stage_type)) > 0),
  stage_contract jsonb NOT NULL,
  status oakridge.core_status NOT NULL DEFAULT 'pending',
  blocked_reason oakridge.blocked_reason,
  next_actor oakridge.next_actor,
  durable_version bigint NOT NULL DEFAULT 0 CHECK (durable_version >= 0),
  outcome jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at timestamptz,
  UNIQUE (run_id, stage_key),
  UNIQUE (run_id, id),
  UNIQUE (id, durable_version),
  CHECK ((status = 'blocked') = (blocked_reason IS NOT NULL)),
  CHECK ((status IN ('complete', 'failed', 'cancelled')) = (ended_at IS NOT NULL)),
  CHECK (status IN ('complete', 'failed', 'cancelled') OR outcome IS NULL)
);
CREATE INDEX stage_instance_run_status_idx ON oakridge.stage_instance (run_id, status);

CREATE TABLE oakridge.cohort (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL,
  stage_instance_id uuid NOT NULL,
  cohort_key text NOT NULL CHECK (length(btrim(cohort_key)) > 0),
  status oakridge.core_status NOT NULL DEFAULT 'pending',
  blocked_reason oakridge.blocked_reason,
  next_actor oakridge.next_actor,
  durable_version bigint NOT NULL DEFAULT 0 CHECK (durable_version >= 0),
  stage_data_version integer NOT NULL DEFAULT 1 CHECK (stage_data_version > 0),
  stage_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at timestamptz,
  UNIQUE (run_id, stage_instance_id, cohort_key),
  UNIQUE (run_id, id),
  UNIQUE (run_id, stage_instance_id, id),
  UNIQUE (id, durable_version),
  FOREIGN KEY (run_id, stage_instance_id)
    REFERENCES oakridge.stage_instance(run_id, id) ON DELETE CASCADE,
  CHECK ((status = 'blocked') = (blocked_reason IS NOT NULL)),
  CHECK ((status IN ('complete', 'failed', 'cancelled')) = (ended_at IS NOT NULL)),
  CHECK (status IN ('complete', 'failed', 'cancelled') OR outcome IS NULL)
);
CREATE INDEX cohort_stage_status_idx ON oakridge.cohort (run_id, stage_instance_id, status);

CREATE TABLE oakridge.attempt (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL,
  stage_instance_id uuid NOT NULL,
  cohort_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  status oakridge.attempt_status NOT NULL DEFAULT 'pending',
  adapter_type text NOT NULL CHECK (length(btrim(adapter_type)) > 0),
  request jsonb NOT NULL,
  outcome jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at timestamptz,
  UNIQUE (cohort_id, attempt_number),
  UNIQUE (run_id, stage_instance_id, id),
  FOREIGN KEY (run_id, stage_instance_id, cohort_id)
    REFERENCES oakridge.cohort(run_id, stage_instance_id, id) ON DELETE CASCADE,
  CHECK ((status IN ('complete', 'failed', 'cancelled')) = (ended_at IS NOT NULL)),
  CHECK (status IN ('complete', 'failed', 'cancelled') OR outcome IS NULL)
);
CREATE INDEX attempt_cohort_status_idx ON oakridge.attempt (cohort_id, status, attempt_number DESC);

CREATE TABLE oakridge.session (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL,
  stage_instance_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  launch_transition_id uuid NOT NULL,
  status oakridge.session_status NOT NULL DEFAULT 'pending',
  kbbl_session_id text,
  adapter_reference jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at timestamptz,
  UNIQUE (attempt_id),
  UNIQUE (run_id, id),
  UNIQUE (attempt_id, id),
  FOREIGN KEY (run_id, stage_instance_id, attempt_id)
    REFERENCES oakridge.attempt(run_id, stage_instance_id, id) ON DELETE CASCADE,
  CHECK (kbbl_session_id IS NULL OR length(btrim(kbbl_session_id)) > 0),
  CHECK ((status IN ('complete', 'failed', 'cancelled')) = (ended_at IS NOT NULL))
);
CREATE UNIQUE INDEX session_kbbl_session_id_unique_idx
  ON oakridge.session (kbbl_session_id) WHERE kbbl_session_id IS NOT NULL;
CREATE INDEX session_attempt_idx ON oakridge.session (attempt_id);

CREATE TABLE oakridge.artifact (
  id uuid PRIMARY KEY,
  chain_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  parent_artifact_id uuid REFERENCES oakridge.artifact(id),
  artifact_type text NOT NULL CHECK (length(btrim(artifact_type)) > 0),
  body jsonb NOT NULL,
  label text,
  lifecycle oakridge.artifact_lifecycle NOT NULL DEFAULT 'current',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, artifact_type),
  UNIQUE (chain_id, revision),
  UNIQUE (parent_artifact_id),
  CHECK ((revision = 1) = (parent_artifact_id IS NULL)),
  CHECK (revision <> 1 OR chain_id = id)
);
CREATE INDEX artifact_chain_idx ON oakridge.artifact (chain_id, revision DESC);
CREATE INDEX artifact_type_idx ON oakridge.artifact (artifact_type);
CREATE UNIQUE INDEX artifact_chain_current_unique_idx
  ON oakridge.artifact (chain_id) WHERE lifecycle = 'current';

CREATE FUNCTION oakridge.validate_artifact_revision_parent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent oakridge.artifact%ROWTYPE;
BEGIN
  IF NEW.parent_artifact_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO parent
  FROM oakridge.artifact
  WHERE id = NEW.parent_artifact_id;

  IF NOT FOUND
    OR parent.chain_id <> NEW.chain_id
    OR parent.artifact_type <> NEW.artifact_type
    OR parent.revision + 1 <> NEW.revision
  THEN
    RAISE EXCEPTION 'artifact revision % has an invalid parent %', NEW.id, NEW.parent_artifact_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER artifact_revision_parent_check
AFTER INSERT OR UPDATE OF parent_artifact_id, chain_id, artifact_type, revision
ON oakridge.artifact
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION oakridge.validate_artifact_revision_parent();

-- Ownership says whose durable state contains the artifact. A null cohort is
-- a run-owned artifact; MATCH FULL rejects half-populated cohort identity.
CREATE TABLE oakridge.artifact_owner (
  artifact_id uuid PRIMARY KEY REFERENCES oakridge.artifact(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES oakridge.workflow_run(id) ON DELETE CASCADE,
  stage_instance_id uuid,
  cohort_id uuid,
  UNIQUE (run_id, artifact_id),
  FOREIGN KEY (run_id, stage_instance_id, cohort_id)
    REFERENCES oakridge.cohort(run_id, stage_instance_id, id),
  CHECK ((cohort_id IS NULL) = (stage_instance_id IS NULL))
);
CREATE INDEX artifact_owner_run_idx ON oakridge.artifact_owner (run_id, cohort_id);

-- Acceptance is independent from ownership and provenance: it names the
-- receiving stage and declared output slot that accepted this revision.
CREATE TABLE oakridge.artifact_acceptance (
  artifact_id uuid PRIMARY KEY REFERENCES oakridge.artifact(id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  receiving_stage_instance_id uuid NOT NULL,
  output_name text NOT NULL CHECK (length(btrim(output_name)) > 0),
  artifact_type text NOT NULL CHECK (length(btrim(artifact_type)) > 0),
  collection_key text,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id, receiving_stage_instance_id)
    REFERENCES oakridge.stage_instance(run_id, id) ON DELETE CASCADE,
  FOREIGN KEY (artifact_id, artifact_type)
    REFERENCES oakridge.artifact(id, artifact_type) ON DELETE CASCADE,
  CHECK (collection_key IS NULL OR length(collection_key) > 0)
);
CREATE UNIQUE INDEX artifact_acceptance_scalar_slot_idx
  ON oakridge.artifact_acceptance (receiving_stage_instance_id, output_name, artifact_id)
  WHERE collection_key IS NULL;
CREATE UNIQUE INDEX artifact_acceptance_collection_slot_idx
  ON oakridge.artifact_acceptance (receiving_stage_instance_id, output_name, collection_key, artifact_id)
  WHERE collection_key IS NOT NULL;

-- Provenance is a discriminated union. A stage-produced artifact always names
-- its stage and attempt; its session may be absent while the session is being
-- ensured. Imports and actions cannot accidentally carry a partial tuple.
CREATE TABLE oakridge.artifact_provenance (
  artifact_id uuid PRIMARY KEY REFERENCES oakridge.artifact(id) ON DELETE CASCADE,
  kind oakridge.artifact_provenance_kind NOT NULL,
  run_id uuid NOT NULL REFERENCES oakridge.workflow_run(id) ON DELETE CASCADE,
  stage_instance_id uuid,
  attempt_id uuid,
  session_id uuid,
  service_action text,
  operator_action text,
  import_source jsonb,
  FOREIGN KEY (run_id, stage_instance_id, attempt_id)
    REFERENCES oakridge.attempt(run_id, stage_instance_id, id),
  FOREIGN KEY (run_id, session_id)
    REFERENCES oakridge.session(run_id, id),
  FOREIGN KEY (attempt_id, session_id)
    REFERENCES oakridge.session(attempt_id, id),
  CHECK (
    (kind = 'stage_attempt' AND stage_instance_id IS NOT NULL AND attempt_id IS NOT NULL
      AND service_action IS NULL AND operator_action IS NULL AND import_source IS NULL)
    OR (kind = 'service_action' AND stage_instance_id IS NULL AND attempt_id IS NULL AND session_id IS NULL
      AND service_action IS NOT NULL AND operator_action IS NULL AND import_source IS NULL)
    OR (kind = 'operator_action' AND stage_instance_id IS NULL AND attempt_id IS NULL AND session_id IS NULL
      AND service_action IS NULL AND operator_action IS NOT NULL AND import_source IS NULL)
    OR (kind = 'import' AND stage_instance_id IS NULL AND attempt_id IS NULL AND session_id IS NULL
      AND service_action IS NULL AND operator_action IS NULL AND import_source IS NOT NULL)
  )
);
CREATE INDEX artifact_provenance_attempt_idx
  ON oakridge.artifact_provenance (attempt_id) WHERE attempt_id IS NOT NULL;
CREATE INDEX artifact_provenance_session_idx
  ON oakridge.artifact_provenance (session_id) WHERE session_id IS NOT NULL;

CREATE TABLE oakridge.wait_gate (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES oakridge.workflow_run(id) ON DELETE CASCADE,
  stage_instance_id uuid,
  cohort_id uuid,
  kind oakridge.wait_kind NOT NULL,
  status oakridge.wait_status NOT NULL DEFAULT 'open',
  closes_on jsonb NOT NULL,
  outcome jsonb,
  command_workflow_id text NOT NULL UNIQUE,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  UNIQUE (run_id, id),
  FOREIGN KEY (run_id, stage_instance_id, cohort_id)
    REFERENCES oakridge.cohort(run_id, stage_instance_id, id),
  CHECK ((cohort_id IS NULL) = (stage_instance_id IS NULL)),
  CHECK ((status = 'open') = (closed_at IS NULL)),
  CHECK ((status = 'open') = (outcome IS NULL))
);
CREATE INDEX wait_gate_run_status_idx ON oakridge.wait_gate (run_id, status);

CREATE TABLE oakridge.wait_gate_artifact_revision (
  wait_gate_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  run_id uuid NOT NULL,
  FOREIGN KEY (run_id, wait_gate_id) REFERENCES oakridge.wait_gate(run_id, id) ON DELETE CASCADE,
  FOREIGN KEY (run_id, artifact_id) REFERENCES oakridge.artifact_owner(run_id, artifact_id),
  PRIMARY KEY (wait_gate_id, artifact_id)
);

CREATE TABLE oakridge.wait_gate_output_slot (
  wait_gate_id uuid NOT NULL REFERENCES oakridge.wait_gate(id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  receiving_stage_instance_id uuid NOT NULL,
  output_name text NOT NULL CHECK (length(btrim(output_name)) > 0),
  collection_key text,
  UNIQUE NULLS NOT DISTINCT (wait_gate_id, receiving_stage_instance_id, output_name, collection_key),
  FOREIGN KEY (run_id, wait_gate_id) REFERENCES oakridge.wait_gate(run_id, id) ON DELETE CASCADE,
  FOREIGN KEY (run_id, receiving_stage_instance_id)
    REFERENCES oakridge.stage_instance(run_id, id) ON DELETE CASCADE,
  CHECK (collection_key IS NULL OR length(collection_key) > 0)
);
CREATE INDEX wait_gate_output_slot_stage_idx
  ON oakridge.wait_gate_output_slot (run_id, receiving_stage_instance_id, output_name);

CREATE TABLE oakridge.run_transition (
  id uuid PRIMARY KEY,
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  run_id uuid NOT NULL REFERENCES oakridge.workflow_run(id) ON DELETE CASCADE,
  owner_kind oakridge.transition_owner_kind NOT NULL,
  owner_run_id uuid,
  owner_stage_instance_id uuid,
  owner_cohort_id uuid,
  launch_reason oakridge.transition_launch_reason NOT NULL,
  prior_owner_version bigint NOT NULL CHECK (prior_owner_version >= 0),
  resulting_owner_version bigint NOT NULL,
  effect_descriptor jsonb NOT NULL,
  effect_workflow_id text NOT NULL UNIQUE,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id, owner_stage_instance_id)
    REFERENCES oakridge.stage_instance(run_id, id),
  FOREIGN KEY (run_id, owner_cohort_id)
    REFERENCES oakridge.cohort(run_id, id),
  CHECK (
    (owner_kind = 'run' AND owner_run_id = run_id AND owner_stage_instance_id IS NULL AND owner_cohort_id IS NULL)
    OR (owner_kind = 'stage_instance' AND owner_run_id IS NULL AND owner_stage_instance_id IS NOT NULL AND owner_cohort_id IS NULL)
    OR (owner_kind = 'cohort' AND owner_run_id IS NULL AND owner_stage_instance_id IS NULL AND owner_cohort_id IS NOT NULL)
  ),
  CHECK (resulting_owner_version = prior_owner_version + 1),
  CHECK (jsonb_typeof(effect_descriptor) = 'object'),
  CHECK (length(coalesce(effect_descriptor->>'kind', '')) > 0)
);
CREATE INDEX run_transition_run_sequence_idx ON oakridge.run_transition (run_id, sequence);
CREATE INDEX run_transition_stage_owner_idx ON oakridge.run_transition (owner_stage_instance_id, resulting_owner_version)
  WHERE owner_stage_instance_id IS NOT NULL;
CREATE INDEX run_transition_cohort_owner_idx ON oakridge.run_transition (owner_cohort_id, resulting_owner_version)
  WHERE owner_cohort_id IS NOT NULL;

ALTER TABLE oakridge.session
  ADD CONSTRAINT session_launch_transition_fk
  FOREIGN KEY (launch_transition_id) REFERENCES oakridge.run_transition(id);

CREATE FUNCTION oakridge.validate_transition_owner_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  persisted_version bigint;
BEGIN
  CASE NEW.owner_kind
    WHEN 'run' THEN
      SELECT record_version INTO persisted_version
      FROM oakridge.workflow_run WHERE id = NEW.owner_run_id;
    WHEN 'stage_instance' THEN
      SELECT durable_version INTO persisted_version
      FROM oakridge.stage_instance WHERE id = NEW.owner_stage_instance_id;
    WHEN 'cohort' THEN
      SELECT durable_version INTO persisted_version
      FROM oakridge.cohort WHERE id = NEW.owner_cohort_id;
  END CASE;

  IF persisted_version IS DISTINCT FROM NEW.resulting_owner_version THEN
    RAISE EXCEPTION 'transition % resulting owner version % does not match persisted version %',
      NEW.id, NEW.resulting_owner_version, persisted_version
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER run_transition_owner_version_check
AFTER INSERT OR UPDATE OF owner_kind, owner_run_id, owner_stage_instance_id, owner_cohort_id, resulting_owner_version
ON oakridge.run_transition
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION oakridge.validate_transition_owner_version();

CREATE TABLE oakridge.session_message (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES oakridge.workflow_run(id) ON DELETE CASCADE,
  cohort_id uuid,
  sender_kind oakridge.message_party_kind NOT NULL,
  sender_id text,
  recipient_kind oakridge.message_party_kind NOT NULL,
  recipient_id text,
  thread_id text NOT NULL CHECK (length(btrim(thread_id)) > 0),
  message_id text NOT NULL CHECK (length(btrim(message_id)) > 0),
  artifact_thread_id uuid,
  body jsonb NOT NULL,
  delivery_key text NOT NULL CHECK (length(btrim(delivery_key)) > 0),
  delivery_status oakridge.delivery_status NOT NULL DEFAULT 'pending',
  delivery_result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  FOREIGN KEY (run_id, cohort_id) REFERENCES oakridge.cohort(run_id, id),
  UNIQUE (run_id, delivery_key),
  UNIQUE (run_id, thread_id, message_id),
  CHECK ((delivery_status = 'pending') = (delivery_result IS NULL)),
  CHECK ((delivery_status = 'delivered') = (delivered_at IS NOT NULL))
);
CREATE INDEX session_message_context_idx ON oakridge.session_message (run_id, cohort_id, created_at);
CREATE INDEX session_message_recipient_idx ON oakridge.session_message (recipient_kind, recipient_id, delivery_status);

CREATE TABLE oakridge.runtime_secret (
  name text PRIMARY KEY,
  value text NOT NULL CHECK (length(value) >= 32),
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO oakridge.runtime_secret (name, value)
VALUES ('work_order_capability', gen_random_uuid()::text || gen_random_uuid()::text);
