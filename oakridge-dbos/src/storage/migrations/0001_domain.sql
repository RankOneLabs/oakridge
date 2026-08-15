CREATE SCHEMA IF NOT EXISTS oakridge;

CREATE TABLE oakridge.workflow_definition (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  definition jsonb NOT NULL,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  UNIQUE (name, version)
);

CREATE TABLE oakridge.workflow_run (
  id uuid PRIMARY KEY,
  workflow_definition_id uuid NOT NULL REFERENCES oakridge.workflow_definition(id),
  project_id uuid,
  context jsonb NOT NULL,
  root_workflow_id text NOT NULL UNIQUE,
  attempt_of uuid REFERENCES oakridge.workflow_run(id),
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX workflow_run_archived ON oakridge.workflow_run (archived);

CREATE TABLE oakridge.stage_instance (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES oakridge.workflow_run(id) ON DELETE CASCADE,
  stage_key text NOT NULL,
  stage_type text NOT NULL,
  stage_contract jsonb NOT NULL,
  coordinator_workflow_id text NOT NULL UNIQUE,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  outcome jsonb,
  UNIQUE (run_id, stage_key),
  CHECK ((ended_at IS NULL) = (outcome IS NULL))
);

CREATE TABLE oakridge.artifact (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES oakridge.workflow_run(id) ON DELETE CASCADE,
  stage_instance_id uuid NOT NULL REFERENCES oakridge.stage_instance(id) ON DELETE CASCADE,
  execution_id text NOT NULL,
  unit_id text NOT NULL,
  output_name text NOT NULL,
  artifact_type text NOT NULL,
  body jsonb NOT NULL,
  label text,
  version integer NOT NULL CHECK (version > 0),
  parent_artifact_id uuid REFERENCES oakridge.artifact(id),
  emission_idempotency_key text NOT NULL,
  emission_payload_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stage_instance_id, execution_id, unit_id, output_name, emission_idempotency_key)
);

CREATE UNIQUE INDEX artifact_resource_version
  ON oakridge.artifact (stage_instance_id, execution_id, unit_id, output_name, version);

CREATE TABLE oakridge.command_outbox (
  id uuid PRIMARY KEY,
  command_type text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  target_workflow_id text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);

CREATE TABLE oakridge.gate_decision_audit (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES oakridge.workflow_run(id) ON DELETE CASCADE,
  stage_instance_id uuid NOT NULL REFERENCES oakridge.stage_instance(id) ON DELETE CASCADE,
  execution_id text NOT NULL,
  unit_id text NOT NULL,
  artifact_chain_id uuid NOT NULL REFERENCES oakridge.artifact(id),
  artifact_revision_id uuid NOT NULL REFERENCES oakridge.artifact(id),
  gate_step text NOT NULL,
  action text NOT NULL,
  operator_comment text,
  feedback text,
  applied_at timestamptz,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oakridge.executor_projection (
  execution_id text PRIMARY KEY,
  execution_workflow_id text NOT NULL UNIQUE,
  stage_instance_id uuid NOT NULL REFERENCES oakridge.stage_instance(id) ON DELETE CASCADE,
  unit_id text NOT NULL,
  executor_type text NOT NULL,
  unit_parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  input_artifacts jsonb NOT NULL DEFAULT '[]'::jsonb,
  external_reference jsonb,
  terminal_observation jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stage_instance_id, unit_id, execution_id)
);

CREATE TABLE oakridge.epic_workflow_profile (
  id uuid PRIMARY KEY,
  workflow_run_id uuid NOT NULL UNIQUE REFERENCES oakridge.workflow_run(id) ON DELETE CASCADE,
  title text NOT NULL,
  slug text NOT NULL,
  lifecycle_state text NOT NULL,
  final_merge_policy text NOT NULL,
  repositories jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oakridge.cohort_pull_request_reconciliation (
  workflow_run_id uuid NOT NULL REFERENCES oakridge.workflow_run(id) ON DELETE CASCADE,
  stage_instance_id uuid NOT NULL REFERENCES oakridge.stage_instance(id) ON DELETE CASCADE,
  unit_id text NOT NULL,
  repository_key text NOT NULL,
  observation jsonb NOT NULL,
  mismatch jsonb,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (stage_instance_id, unit_id)
);

CREATE INDEX cohort_pull_request_reconciliation_run
  ON oakridge.cohort_pull_request_reconciliation (workflow_run_id);

CREATE TABLE oakridge.collaboration_thread (
  id uuid PRIMARY KEY,
  artifact_id uuid NOT NULL REFERENCES oakridge.artifact(id) ON DELETE CASCADE,
  revision_id uuid NOT NULL REFERENCES oakridge.artifact(id) ON DELETE CASCADE,
  anchor text,
  status text NOT NULL CHECK (status IN ('open', 'resolved')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oakridge.collaboration_message (
  id uuid PRIMARY KEY,
  thread_id uuid NOT NULL REFERENCES oakridge.collaboration_thread(id) ON DELETE CASCADE,
  body text NOT NULL,
  author text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oakridge.review_item (
  id uuid PRIMARY KEY,
  artifact_id uuid NOT NULL REFERENCES oakridge.artifact(id) ON DELETE CASCADE,
  revision_id uuid NOT NULL REFERENCES oakridge.artifact(id) ON DELETE CASCADE,
  anchor text NOT NULL,
  claim text NOT NULL,
  reality text NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'resolved', 'waived')),
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now()
);
