ALTER TABLE oakridge.workflow_run
  ADD COLUMN state text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'succeeded', 'failed', 'cancelled')),
  ADD COLUMN outcome jsonb,
  ADD COLUMN record_version bigint NOT NULL DEFAULT 0 CHECK (record_version >= 0),
  ADD COLUMN ended_at timestamptz,
  ADD CONSTRAINT workflow_run_v2_terminal_shape CHECK (
    (state = 'active' AND outcome IS NULL AND ended_at IS NULL)
    OR (state <> 'active' AND outcome IS NOT NULL AND ended_at IS NOT NULL)
  );

ALTER TABLE oakridge.stage_instance
  ADD COLUMN state text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'succeeded', 'failed', 'cancelled')),
  ADD COLUMN materialization_closed boolean NOT NULL DEFAULT false;

-- Old topology stages remain attempt-scoped. New topology stages deliberately
-- carry no attempt: DBOS recovery is not application domain state.
ALTER TABLE oakridge.stage_instance ALTER COLUMN attempt_root_workflow_id DROP NOT NULL;
CREATE UNIQUE INDEX stage_instance_v2_run_stage
  ON oakridge.stage_instance (run_id, stage_key)
  WHERE attempt_root_workflow_id IS NULL;

CREATE TABLE oakridge.run_unit (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES oakridge.workflow_run(id) ON DELETE CASCADE,
  stage_instance_id uuid NOT NULL REFERENCES oakridge.stage_instance(id) ON DELETE CASCADE,
  unit_id text NOT NULL,
  parameters jsonb NOT NULL,
  input_snapshot jsonb NOT NULL,
  input_fingerprint text NOT NULL,
  state text NOT NULL CHECK (state IN ('ready', 'working', 'waiting', 'satisfied', 'failed', 'cancelled')),
  outcome jsonb,
  created_at timestamptz NOT NULL,
  ended_at timestamptz,
  UNIQUE (stage_instance_id, unit_id),
  CHECK (
    (state IN ('ready', 'working', 'waiting') AND outcome IS NULL AND ended_at IS NULL)
    OR (state IN ('satisfied', 'failed', 'cancelled') AND outcome IS NOT NULL AND ended_at IS NOT NULL)
  )
);

CREATE INDEX run_unit_run_state ON oakridge.run_unit (run_id, state);

CREATE TABLE oakridge.run_output_slot (
  run_unit_id uuid NOT NULL REFERENCES oakridge.run_unit(id) ON DELETE CASCADE,
  output_name text NOT NULL,
  artifact_type text NOT NULL,
  required boolean NOT NULL,
  state text NOT NULL CHECK (state IN ('empty', 'pending', 'released', 'invalidated')),
  artifact_revision_id uuid REFERENCES oakridge.artifact(id),
  release_wait_id uuid REFERENCES oakridge.wait(id),
  invalidation_reason jsonb,
  state_changed_at timestamptz,
  updated_by_work_order_id uuid,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  PRIMARY KEY (run_unit_id, output_name),
  CHECK (
    (state = 'empty' AND artifact_revision_id IS NULL AND release_wait_id IS NULL AND invalidation_reason IS NULL)
    OR (state = 'pending' AND artifact_revision_id IS NOT NULL AND release_wait_id IS NOT NULL AND invalidation_reason IS NULL AND state_changed_at IS NOT NULL)
    OR (state = 'released' AND artifact_revision_id IS NOT NULL AND release_wait_id IS NULL AND invalidation_reason IS NULL AND state_changed_at IS NOT NULL)
    OR (state = 'invalidated' AND release_wait_id IS NULL AND invalidation_reason IS NOT NULL AND state_changed_at IS NOT NULL)
  )
);

CREATE TABLE oakridge.work_order (
  id uuid PRIMARY KEY,
  run_unit_id uuid NOT NULL REFERENCES oakridge.run_unit(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (reason IN ('initial', 'operator_retry', 'input_revision')),
  input_snapshot jsonb NOT NULL,
  input_fingerprint text NOT NULL,
  state text NOT NULL CHECK (state IN ('available', 'started', 'completed', 'abandoned')),
  workflow_id text NOT NULL UNIQUE,
  request_idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (run_unit_id, request_idempotency_key),
  CHECK ((state IN ('available', 'started') AND completed_at IS NULL)
    OR (state IN ('completed', 'abandoned') AND completed_at IS NOT NULL))
);

ALTER TABLE oakridge.run_output_slot
  ADD CONSTRAINT run_output_slot_work_order_fk
  FOREIGN KEY (updated_by_work_order_id) REFERENCES oakridge.work_order(id);

CREATE INDEX work_order_unit_state ON oakridge.work_order (run_unit_id, state);

CREATE TABLE oakridge.executor_attachment (
  work_order_id uuid PRIMARY KEY REFERENCES oakridge.work_order(id) ON DELETE CASCADE,
  executor_type text NOT NULL,
  external_reference jsonb,
  health jsonb,
  cleanup_state text NOT NULL DEFAULT 'not_needed'
    CHECK (cleanup_state IN ('not_needed', 'requested', 'complete', 'failed')),
  updated_at timestamptz NOT NULL
);

ALTER TABLE oakridge.artifact
  ADD COLUMN work_order_id uuid REFERENCES oakridge.work_order(id);

CREATE UNIQUE INDEX artifact_work_order_effect
  ON oakridge.artifact (work_order_id, output_name, emission_idempotency_key)
  WHERE work_order_id IS NOT NULL;
