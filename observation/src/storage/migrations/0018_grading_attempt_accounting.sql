-- Preserve each live job's original total attempt allowance under retry-count semantics.
-- The migration owner must see every tenant while rewriting existing rows.
ALTER TABLE observation.grading_job NO FORCE ROW LEVEL SECURITY;
ALTER TABLE observation.evaluation_execution NO FORCE ROW LEVEL SECURITY;
UPDATE observation.grading_job
SET retry_limit = GREATEST(retry_limit - 1, 0)
WHERE state IN ('queued', 'claimed', 'reclaimable');

CREATE TABLE observation.grading_provider_attempt (
  producer text NOT NULL,
  namespace text NOT NULL,
  job_id text NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  run_id text NOT NULL,
  stage_id text NOT NULL,
  request_sent boolean NOT NULL DEFAULT false,
  outcome text CHECK (outcome IS NULL OR outcome IN ('completed', 'failed')),
  charged_cost double precision NOT NULL DEFAULT 0 CHECK (charged_cost >= 0),
  admitted_estimate double precision NOT NULL CHECK (admitted_estimate >= 0),
  cost_overage double precision NOT NULL DEFAULT 0 CHECK (cost_overage >= 0),
  provider_request_id text,
  failure_category text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (producer, namespace, job_id, attempt),
  FOREIGN KEY (producer, namespace, job_id)
    REFERENCES observation.grading_job(producer, namespace, job_id),
  CHECK (request_sent OR charged_cost = 0)
);
-- Old audit entries were written before provider preflight, so sent-ness cannot be
-- recovered exactly. Preserve their conservative charge; new rows separate the facts.
INSERT INTO observation.grading_provider_attempt
  (producer, namespace, job_id, attempt, run_id, stage_id, request_sent, outcome,
   charged_cost, admitted_estimate, cost_overage, provider_request_id, failure_category)
SELECT DISTINCT ON (j.producer, j.namespace, j.job_id, (entry->>'attempt')::integer)
  j.producer, j.namespace, j.job_id, (entry->>'attempt')::integer, j.run_id, j.stage_id,
  true,
  CASE WHEN entry->>'status' IN ('completed', 'failed') THEN entry->>'status' ELSE NULL END,
  CASE WHEN jsonb_typeof(entry->'cost') = 'number' THEN GREATEST((entry->>'cost')::double precision, 0) ELSE 0 END,
  CASE WHEN jsonb_typeof(entry->'estimated_cost') = 'number' THEN GREATEST((entry->>'estimated_cost')::double precision, 0) ELSE 0 END,
  CASE WHEN jsonb_typeof(entry->'cost_overage') = 'number' THEN GREATEST((entry->>'cost_overage')::double precision, 0) ELSE 0 END,
  entry->>'request_id', NULL
FROM observation.evaluation_execution AS e
CROSS JOIN LATERAL jsonb_array_elements(e.provider_attempts) WITH ORDINALITY AS entries(entry, ordinal)
JOIN observation.grading_job AS j
  ON j.producer = e.producer AND j.namespace = e.namespace
  AND j.job_id = entry->>'job_id'
WHERE entry->>'attempt' ~ '^[1-9][0-9]*$'
ORDER BY j.producer, j.namespace, j.job_id, (entry->>'attempt')::integer, ordinal DESC;
ALTER TABLE observation.grading_job FORCE ROW LEVEL SECURITY;
ALTER TABLE observation.evaluation_execution FORCE ROW LEVEL SECURITY;
CREATE INDEX grading_provider_attempt_spend
  ON observation.grading_provider_attempt (producer, namespace, run_id, stage_id)
  INCLUDE (job_id, attempt, charged_cost);
ALTER TABLE observation.grading_provider_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE observation.grading_provider_attempt FORCE ROW LEVEL SECURITY;
CREATE POLICY grading_provider_attempt_tenant ON observation.grading_provider_attempt
  USING (producer = current_setting('observation.producer', true)
    AND namespace = current_setting('observation.namespace', true))
  WITH CHECK (producer = current_setting('observation.producer', true)
    AND namespace = current_setting('observation.namespace', true));
