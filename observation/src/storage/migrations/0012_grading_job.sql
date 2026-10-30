CREATE TABLE observation.grading_job (
  producer text NOT NULL,
  namespace text NOT NULL,
  job_id text NOT NULL,
  subject_occurrence_id text NOT NULL,
  evidence_set_id text NOT NULL,
  question_id text NOT NULL,
  question_version text NOT NULL,
  evaluator_definition_id text NOT NULL,
  config_digest text NOT NULL,
  attempt_label text NOT NULL,
  idempotency_digest text NOT NULL,
  reviewed_commit text,
  runner_name text NOT NULL,
  run_id text NOT NULL,
  stage_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'claimed', 'reclaimable', 'terminal', 'skipped_budget')),
  lease_owner text,
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  retry_limit integer NOT NULL,
  terminal_cause text CHECK (terminal_cause IS NULL OR terminal_cause IN ('retry_exhausted', 'runner_failed', 'disclosure_refused', 'invalid_outcome', 'budget_exceeded')),
  estimated_cost double precision NOT NULL DEFAULT 0,
  disclosure jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (producer, namespace, job_id),
  UNIQUE (producer, namespace, idempotency_digest),
  FOREIGN KEY (producer, namespace, subject_occurrence_id) REFERENCES observation.item_occurrence(producer, namespace, occurrence_id),
  FOREIGN KEY (producer, namespace, evidence_set_id) REFERENCES observation.evidence_set(producer, namespace, evidence_set_id),
  FOREIGN KEY (producer, namespace, question_id, question_version) REFERENCES observation.question_definition(producer, namespace, question_id, question_version),
  FOREIGN KEY (producer, namespace, evaluator_definition_id) REFERENCES observation.evaluator_definition(producer, namespace, evaluator_definition_id),
  CHECK (attempts >= 0 AND retry_limit >= 0 AND estimated_cost >= 0),
  CHECK ((state = 'claimed') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (idempotency_digest ~ '^canonical-json/v1:[0-9a-f]{64}$')
);
CREATE INDEX grading_job_claim ON observation.grading_job (state, lease_expires_at, created_at)
  WHERE state IN ('queued', 'claimed', 'reclaimable');
CREATE INDEX grading_job_item ON observation.grading_job (producer, namespace, subject_occurrence_id, created_at);
ALTER TABLE observation.grading_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE observation.grading_job FORCE ROW LEVEL SECURITY;
CREATE POLICY grading_job_tenant ON observation.grading_job
  USING (producer = current_setting('observation.producer', true) AND namespace = current_setting('observation.namespace', true))
  WITH CHECK (producer = current_setting('observation.producer', true) AND namespace = current_setting('observation.namespace', true));

-- Eligibility remains append-only when a previously eligible subject is skipped by a cap.
ALTER TABLE observation.evaluation_eligibility DROP CONSTRAINT evaluation_eligibility_pkey;
ALTER TABLE observation.evaluation_eligibility
  ADD COLUMN eligibility_id text NOT NULL DEFAULT gen_random_uuid()::text;
ALTER TABLE observation.evaluation_eligibility
  ADD PRIMARY KEY (producer, namespace, eligibility_id);

-- Recovery may repeat a paid request; retain each returned request id and cost
-- on the one canonical execution, including a response whose lease has expired.
ALTER TABLE observation.evaluation_execution
  ADD COLUMN provider_attempts jsonb NOT NULL DEFAULT '[]'::jsonb;
