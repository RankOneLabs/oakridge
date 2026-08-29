-- A slot is either scalar (no collection key) or one independently-addressed
-- member of a declared collection.  NULL is absence; empty strings are never
-- a second spelling for scalar identity.
ALTER TABLE oakridge.run_output_slot
  ADD COLUMN collection_key text,
  ADD CONSTRAINT run_output_slot_collection_key_nonempty
    CHECK (collection_key IS NULL OR length(collection_key) > 0);

ALTER TABLE oakridge.run_output_slot DROP CONSTRAINT run_output_slot_pkey;
CREATE UNIQUE INDEX run_output_slot_scalar_identity
  ON oakridge.run_output_slot (run_unit_id, output_name)
  WHERE collection_key IS NULL;
CREATE UNIQUE INDEX run_output_slot_collection_identity
  ON oakridge.run_output_slot (run_unit_id, output_name, collection_key)
  WHERE collection_key IS NOT NULL;

ALTER TABLE oakridge.artifact
  ADD COLUMN collection_key text,
  ADD CONSTRAINT artifact_collection_key_nonempty
    CHECK (collection_key IS NULL OR length(collection_key) > 0);
DROP INDEX oakridge.artifact_resource_version;
CREATE UNIQUE INDEX artifact_scalar_resource_version
  ON oakridge.artifact (stage_instance_id, execution_id, unit_id, output_name, version)
  WHERE collection_key IS NULL;
CREATE UNIQUE INDEX artifact_collection_resource_version
  ON oakridge.artifact (stage_instance_id, execution_id, unit_id, output_name, collection_key, version)
  WHERE collection_key IS NOT NULL;
ALTER TABLE oakridge.artifact DROP CONSTRAINT artifact_one_effective_revision;
CREATE UNIQUE INDEX artifact_one_effective_scalar_revision
  ON oakridge.artifact (stage_instance_id, execution_id, unit_id, output_name)
  WHERE effective_slot AND collection_key IS NULL;
CREATE UNIQUE INDEX artifact_one_effective_collection_revision
  ON oakridge.artifact (stage_instance_id, execution_id, unit_id, output_name, collection_key)
  WHERE effective_slot AND collection_key IS NOT NULL;
DROP INDEX oakridge.artifact_work_order_effect;
CREATE UNIQUE INDEX artifact_work_order_scalar_effect
  ON oakridge.artifact (work_order_id, output_name, emission_idempotency_key)
  WHERE work_order_id IS NOT NULL AND collection_key IS NULL;
CREATE UNIQUE INDEX artifact_work_order_collection_effect
  ON oakridge.artifact (work_order_id, output_name, collection_key, emission_idempotency_key)
  WHERE work_order_id IS NOT NULL AND collection_key IS NOT NULL;

ALTER TABLE oakridge.artifact_emission_idempotency
  ADD COLUMN collection_key text,
  ADD CONSTRAINT artifact_emission_collection_key_nonempty
    CHECK (collection_key IS NULL OR length(collection_key) > 0);
ALTER TABLE oakridge.artifact_emission_idempotency
  DROP CONSTRAINT artifact_emission_idempotency_pkey;
CREATE UNIQUE INDEX artifact_emission_scalar_identity
  ON oakridge.artifact_emission_idempotency
    (stage_instance_id, execution_id, unit_id, output_name, idempotency_key)
  WHERE collection_key IS NULL;
CREATE UNIQUE INDEX artifact_emission_collection_identity
  ON oakridge.artifact_emission_idempotency
    (stage_instance_id, execution_id, unit_id, output_name, collection_key, idempotency_key)
  WHERE collection_key IS NOT NULL;

-- A pending wait owns the complete slot identity too.
DROP INDEX oakridge.wait_v2_open_slot;
ALTER TABLE oakridge.wait
  ADD COLUMN collection_key text,
  ADD CONSTRAINT wait_v2_collection_key_nonempty
    CHECK (collection_key IS NULL OR length(collection_key) > 0);
ALTER TABLE oakridge.wait ADD CONSTRAINT wait_v2_collection_identity_shape
  CHECK (collection_key IS NULL OR run_unit_id IS NOT NULL);
CREATE UNIQUE INDEX wait_v2_open_scalar_slot
  ON oakridge.wait (run_unit_id, output_name)
  WHERE status = 'open' AND run_unit_id IS NOT NULL AND collection_key IS NULL;
CREATE UNIQUE INDEX wait_v2_open_collection_slot
  ON oakridge.wait (run_unit_id, output_name, collection_key)
  WHERE status = 'open' AND run_unit_id IS NOT NULL AND collection_key IS NOT NULL;

-- The compiler-produced dependency graph is application truth.  Both ends are
-- run units so an edge cannot point at an invented workflow-local identity.
CREATE TABLE oakridge.run_unit_dependency (
  stage_instance_id uuid NOT NULL REFERENCES oakridge.stage_instance(id) ON DELETE CASCADE,
  unit_id text NOT NULL,
  depends_on_unit_id text NOT NULL,
  PRIMARY KEY (stage_instance_id, unit_id, depends_on_unit_id),
  FOREIGN KEY (stage_instance_id, unit_id)
    REFERENCES oakridge.run_unit(stage_instance_id, unit_id) ON DELETE CASCADE,
  CHECK (unit_id <> depends_on_unit_id)
);
CREATE INDEX run_unit_dependency_reverse
  ON oakridge.run_unit_dependency (stage_instance_id, depends_on_unit_id, unit_id);

-- Scheduling policy is frozen with the materialized stage instead of being
-- re-derived from a mutable definition or held in a DBOS workflow local.
CREATE TABLE oakridge.run_stage_scheduling_policy (
  stage_instance_id uuid PRIMARY KEY REFERENCES oakridge.stage_instance(id) ON DELETE CASCADE,
  max_parallel integer NOT NULL CHECK (max_parallel > 0),
  manual_admission boolean NOT NULL,
  materialization_fingerprint text NOT NULL
);

ALTER TABLE oakridge.run_unit
  ADD COLUMN admitted boolean NOT NULL DEFAULT true,
  ADD COLUMN admitted_at timestamptz,
  ADD COLUMN materialization_fingerprint text;

ALTER TABLE oakridge.work_order
  ADD COLUMN execution_request jsonb;

CREATE TABLE oakridge.run_admission_command (
  stage_instance_id uuid NOT NULL REFERENCES oakridge.stage_instance(id) ON DELETE CASCADE,
  unit_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  applied_at timestamptz NOT NULL,
  PRIMARY KEY (stage_instance_id, idempotency_key),
  FOREIGN KEY (stage_instance_id, unit_id)
    REFERENCES oakridge.run_unit(stage_instance_id, unit_id) ON DELETE CASCADE
);

ALTER TABLE oakridge.run_transition DROP CONSTRAINT run_transition_operation_check;
ALTER TABLE oakridge.run_transition ADD COLUMN collection_key text
  CHECK (collection_key IS NULL OR length(collection_key) > 0);
ALTER TABLE oakridge.run_transition ADD CONSTRAINT run_transition_operation_check
  CHECK (operation IN (
    'stage_materialized', 'materialization_closed', 'unit_admitted',
    'slot_released', 'slot_pending', 'slot_invalidated',
    'unit_satisfied', 'work_started', 'input_revised'
  ));
