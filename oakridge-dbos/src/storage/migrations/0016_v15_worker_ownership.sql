-- V15 worker ownership. Existing v15 runs are intentionally unsupported.
-- The baseline remains immutable; this migration starts with an empty run ledger.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM oakridge.workflow_run) THEN
    RAISE EXCEPTION '0016 requires an empty v15 run ledger';
  END IF;
END $$;

ALTER TABLE oakridge.attempt
  ADD COLUMN worker text NOT NULL CHECK (worker IN
    ('provision','spec','plan','brief','build','assessment','final_integration'));
ALTER TABLE oakridge.attempt DROP CONSTRAINT attempt_cohort_id_attempt_number_key;
ALTER TABLE oakridge.attempt ADD CONSTRAINT attempt_cohort_worker_number_key
  UNIQUE (cohort_id, worker, attempt_number);
DROP INDEX oakridge.attempt_cohort_status_idx;
CREATE INDEX attempt_worker_status_idx
  ON oakridge.attempt (cohort_id, worker, status, attempt_number DESC);
DROP INDEX oakridge.attempt_cohort_idempotency_key_unique;
CREATE UNIQUE INDEX attempt_worker_idempotency_key_unique
  ON oakridge.attempt (cohort_id, worker, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- One worker row holds only that worker's execution and response state.
CREATE TABLE oakridge.cohort_worker (
  cohort_id uuid NOT NULL REFERENCES oakridge.cohort(id) ON DELETE CASCADE,
  worker text NOT NULL CHECK (worker IN
    ('provision','spec','plan','brief','build','assessment','final_integration')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN
    ('pending','working','awaiting_review','accepted','interrupted','cancelled')),
  active_execution_id text,
  work jsonb,
  response jsonb,
  interrupted jsonb,
  PRIMARY KEY (cohort_id, worker)
);

ALTER TABLE oakridge.cohort
  ADD COLUMN frozen_inputs jsonb NOT NULL CHECK (jsonb_typeof(frozen_inputs)='object' AND frozen_inputs <> '{}'::jsonb),
  ADD COLUMN accepted_build jsonb,
  ADD COLUMN activation_slot integer CHECK (activation_slot BETWEEN 1 AND 4);
CREATE UNIQUE INDEX cohort_stage_activation_slot_unique
  ON oakridge.cohort (stage_instance_id, activation_slot)
  WHERE activation_slot IS NOT NULL;

-- Content and review metadata have independent lifetimes. A new publication
-- replaces the current slot and starts unreviewed without changing old bodies.
CREATE TABLE oakridge.worker_output (
  cohort_id uuid NOT NULL,
  worker text NOT NULL,
  output_name text NOT NULL CHECK (length(btrim(output_name)) > 0),
  collection_key text,
  artifact_id uuid NOT NULL REFERENCES oakridge.artifact(id),
  acceptance_state text NOT NULL DEFAULT 'unreviewed' CHECK
    (acceptance_state IN ('unreviewed','accepted','changes_requested')),
  reviewed_target jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (cohort_id, worker, output_name, collection_key),
  FOREIGN KEY (cohort_id, worker) REFERENCES oakridge.cohort_worker(cohort_id, worker),
  CHECK (collection_key IS NULL OR length(collection_key) > 0),
  CHECK ((acceptance_state = 'unreviewed') = (reviewed_target IS NULL))
);

-- The retired acceptance table encoded acceptance as a lifecycle/supersession
-- sweep. The output slot above owns its review state and exact reviewed target.

CREATE TABLE oakridge.cohort_request_receipt (
  request_id uuid PRIMARY KEY,
  cohort_id uuid NOT NULL REFERENCES oakridge.cohort(id) ON DELETE CASCADE,
  prior_version bigint NOT NULL CHECK (prior_version >= 0),
  resulting_version bigint NOT NULL CHECK (resulting_version = prior_version + 1),
  request jsonb NOT NULL,
  decision jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cohort_id, prior_version)
);

CREATE TABLE oakridge.execution_intent (
  id text PRIMARY KEY,
  cohort_id uuid NOT NULL,
  worker text NOT NULL,
  attempt_id uuid NOT NULL UNIQUE REFERENCES oakridge.attempt(id),
  transition_id uuid NOT NULL REFERENCES oakridge.run_transition(id),
  action_point text NOT NULL,
  resolved_input jsonb NOT NULL,
  prompt text NOT NULL CHECK (length(btrim(prompt)) > 0),
  settings jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK
    (status IN ('pending','dispatching','dispatched','interrupted','cancelled')),
  stop_requested_at timestamptz,
  stop_completed_at timestamptz,
  session_id uuid UNIQUE REFERENCES oakridge.session(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (cohort_id, worker) REFERENCES oakridge.cohort_worker(cohort_id, worker)
);
ALTER TABLE oakridge.cohort_worker ADD CONSTRAINT cohort_worker_active_execution_fk
  FOREIGN KEY (active_execution_id) REFERENCES oakridge.execution_intent(id)
  DEFERRABLE INITIALLY DEFERRED;

-- These are replaced, not parallel sources of acceptance or current inputs.
DROP TABLE oakridge.cohort_output;
DROP TABLE oakridge.artifact_acceptance;
ALTER TABLE oakridge.cohort DROP COLUMN round, DROP COLUMN stage_data, DROP COLUMN stage_data_version;
ALTER TABLE oakridge.artifact_provenance ADD COLUMN output_name text, ADD COLUMN collection_key text;
