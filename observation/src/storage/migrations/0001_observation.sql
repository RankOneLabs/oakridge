-- Observation baseline. Apply only to an empty PostgreSQL 15+ database.
CREATE SCHEMA observation;

CREATE TABLE observation.schema_baseline (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE observation.source_revision (
  producer text NOT NULL,
  namespace text NOT NULL,
  revision_id text NOT NULL,
  run_id text NOT NULL,
  unit_id text NOT NULL,
  artifact_kind text NOT NULL,
  artifact_schema_version text NOT NULL,
  definition_id text NOT NULL,
  body jsonb NOT NULL,
  body_digest text NOT NULL CHECK (body_digest ~ '^canonical-json/v1:[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  predecessor_id text,
  subject_id text,
  PRIMARY KEY (producer, namespace, revision_id),
  CHECK (producer <> '' AND namespace <> '' AND revision_id <> '')
);

CREATE TABLE observation.extractor_definition (
  producer text NOT NULL,
  namespace text NOT NULL,
  artifact_kind text NOT NULL,
  schema_version text NOT NULL,
  extractor_id text NOT NULL,
  extractor_version text NOT NULL,
  item_kind text NOT NULL,
  item_selector text NOT NULL,
  PRIMARY KEY (producer, namespace, artifact_kind, schema_version, extractor_id, extractor_version),
  CHECK (producer <> '' AND namespace <> '' AND extractor_id <> '' AND extractor_version <> '')
);

CREATE TABLE observation.logical_item (
  producer text NOT NULL,
  namespace text NOT NULL,
  logical_item_id text NOT NULL,
  run_id text NOT NULL,
  scope text NOT NULL,
  producer_local_id text NOT NULL,
  PRIMARY KEY (producer, namespace, logical_item_id),
  CHECK (logical_item_id = producer || ':' || namespace || ':' || run_id || ':' || scope || ':' || producer_local_id)
);

CREATE TABLE observation.item_occurrence (
  producer text NOT NULL,
  namespace text NOT NULL,
  occurrence_id text NOT NULL,
  revision_id text NOT NULL,
  run_id text NOT NULL,
  artifact_kind text NOT NULL,
  schema_version text NOT NULL,
  extractor_id text NOT NULL,
  extractor_version text NOT NULL,
  item_kind text NOT NULL,
  item_selector text NOT NULL,
  item_id_or_path text NOT NULL,
  item_scope text,
  producer_local_id text,
  selected_value jsonb NOT NULL,
  logical_item_id text,
  json_pointer text,
  PRIMARY KEY (occurrence_id),
  UNIQUE (producer, namespace, occurrence_id),
  UNIQUE (producer, namespace, revision_id, extractor_id, extractor_version, item_selector, item_id_or_path),
  FOREIGN KEY (producer, namespace, revision_id)
    REFERENCES observation.source_revision(producer, namespace, revision_id),
  FOREIGN KEY (producer, namespace, artifact_kind, schema_version, extractor_id, extractor_version)
    REFERENCES observation.extractor_definition(producer, namespace, artifact_kind, schema_version, extractor_id, extractor_version),
  FOREIGN KEY (producer, namespace, logical_item_id)
    REFERENCES observation.logical_item(producer, namespace, logical_item_id),
  CHECK (occurrence_id ~ '^canonical-json/v1:[0-9a-f]{64}$')
);

CREATE TABLE observation.item_relation (
  producer text NOT NULL,
  namespace text NOT NULL,
  relation_id text NOT NULL,
  source_occurrence_id text,
  source_logical_item_id text,
  target_occurrence_id text,
  target_logical_item_id text,
  unresolved_target_ref text,
  type text NOT NULL CHECK (type IN ('derived_from', 'addresses', 'assesses', 'supersedes', 'split_from', 'merged_from')),
  asserted_by text NOT NULL CHECK (asserted_by IN ('producer_explicit', 'human', 'inferred')),
  evidence_ref text NOT NULL,
  algorithm text,
  algorithm_version text,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (producer, namespace, relation_id),
  FOREIGN KEY (producer, namespace, source_occurrence_id)
    REFERENCES observation.item_occurrence(producer, namespace, occurrence_id),
  FOREIGN KEY (producer, namespace, source_logical_item_id)
    REFERENCES observation.logical_item(producer, namespace, logical_item_id),
  FOREIGN KEY (producer, namespace, target_occurrence_id)
    REFERENCES observation.item_occurrence(producer, namespace, occurrence_id),
  FOREIGN KEY (producer, namespace, target_logical_item_id)
    REFERENCES observation.logical_item(producer, namespace, logical_item_id),
  CHECK (num_nonnulls(source_occurrence_id, source_logical_item_id) = 1),
  CHECK (num_nonnulls(target_occurrence_id, target_logical_item_id, unresolved_target_ref) = 1),
  CHECK ((asserted_by = 'inferred') = (algorithm IS NOT NULL AND algorithm_version IS NOT NULL)),
  CHECK (type <> 'split_from' OR asserted_by = 'human')
);

CREATE TABLE observation.extraction_issue (
  producer text NOT NULL,
  namespace text NOT NULL,
  issue_id text NOT NULL,
  revision_id text NOT NULL,
  extractor_id text NOT NULL,
  extractor_version text NOT NULL,
  item_selector text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('extraction_failed', 'no_matching_items', 'identity_collision', 'unresolved_relation')),
  detail text NOT NULL,
  is_retriable boolean NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (producer, namespace, issue_id),
  FOREIGN KEY (producer, namespace, revision_id)
    REFERENCES observation.source_revision(producer, namespace, revision_id)
);

CREATE TABLE observation.question_definition (
  producer text NOT NULL,
  namespace text NOT NULL,
  question_id text NOT NULL,
  question_version text NOT NULL,
  item_kind text NOT NULL,
  response_kind text NOT NULL CHECK (response_kind IN ('boolean', 'choice', 'ordinal', 'numeric', 'text', 'structured')),
  allowed_values jsonb,
  missing_evidence_policy text NOT NULL CHECK (missing_evidence_policy IN ('fail', 'abstain')),
  abstain_semantics text NOT NULL,
  unclear_semantics text NOT NULL,
  interpretation_caveats text NOT NULL,
  question_text text,
  PRIMARY KEY (producer, namespace, question_id, question_version),
  CHECK (question_id <> '' AND question_version <> ''),
  CHECK (allowed_values IS NULL OR jsonb_typeof(allowed_values) = 'array'),
  CHECK (response_kind NOT IN ('choice', 'ordinal') OR (allowed_values IS NOT NULL AND jsonb_array_length(allowed_values) > 0))
);

CREATE TABLE observation.evidence_set (
  producer text NOT NULL,
  namespace text NOT NULL,
  evidence_set_id text NOT NULL,
  subject_occurrence_id text NOT NULL,
  question_id text NOT NULL,
  question_version text NOT NULL,
  evidence_refs jsonb NOT NULL,
  is_incomplete boolean NOT NULL,
  incompleteness_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (producer, namespace, evidence_set_id),
  UNIQUE (producer, namespace, subject_occurrence_id, question_id, question_version),
  FOREIGN KEY (producer, namespace, subject_occurrence_id) REFERENCES observation.item_occurrence(producer, namespace, occurrence_id),
  FOREIGN KEY (producer, namespace, question_id, question_version) REFERENCES observation.question_definition(producer, namespace, question_id, question_version),
  CHECK (NOT is_incomplete OR evidence_refs = '[]'::jsonb),
  CHECK (evidence_set_id <> '' AND jsonb_typeof(evidence_refs) = 'array'),
  CHECK (is_incomplete = (incompleteness_reason IS NOT NULL)),
  CHECK (incompleteness_reason IS NULL OR incompleteness_reason <> '')
);

CREATE TABLE observation.evaluator_definition (
  producer text NOT NULL,
  namespace text NOT NULL,
  evaluator_definition_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('model', 'code', 'human')),
  backend_kind text NOT NULL,
  provider text NOT NULL,
  model text,
  prompt_digest text NOT NULL,
  config_digest text NOT NULL,
  runtime_revision text NOT NULL,
  cost_metadata jsonb,
  seed integer,
  attempt_controls jsonb,
  identity_digest text NOT NULL,
  instruction_text text,
  PRIMARY KEY (producer, namespace, evaluator_definition_id),
  UNIQUE (producer, namespace, identity_digest),
  CHECK (evaluator_definition_id <> '' AND backend_kind <> '' AND provider <> '' AND runtime_revision <> ''),
  CHECK (identity_digest ~ '^canonical-json/v1:[0-9a-f]{64}$')
);

CREATE TABLE observation.evaluation_execution (
  producer text NOT NULL,
  namespace text NOT NULL,
  execution_id text NOT NULL,
  subject_occurrence_id text NOT NULL,
  evidence_set_id text NOT NULL,
  question_id text NOT NULL,
  question_version text NOT NULL,
  evaluator_definition_id text NOT NULL,
  attempt_label text NOT NULL,
  idempotency_digest text NOT NULL,
  run_id text NOT NULL,
  runner_name text,
  estimated_cost double precision NOT NULL DEFAULT 0,
  lease_owner text,
  lease_expires_at timestamptz,
  retry_limit integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz,
  status text NOT NULL CHECK (status IN ('queued', 'claimed', 'reclaimable', 'budget_deferred', 'completed', 'failed')),
  error text,
  model_usage jsonb,
  cost double precision,
  external_execution_id text,
  provider_link text,
  reproducibility_metadata jsonb,
  PRIMARY KEY (producer, namespace, execution_id),
  UNIQUE (producer, namespace, idempotency_digest),
  FOREIGN KEY (producer, namespace, subject_occurrence_id) REFERENCES observation.item_occurrence(producer, namespace, occurrence_id),
  FOREIGN KEY (producer, namespace, evidence_set_id) REFERENCES observation.evidence_set(producer, namespace, evidence_set_id),
  FOREIGN KEY (producer, namespace, question_id, question_version) REFERENCES observation.question_definition(producer, namespace, question_id, question_version),
  FOREIGN KEY (producer, namespace, evaluator_definition_id) REFERENCES observation.evaluator_definition(producer, namespace, evaluator_definition_id),
  CHECK (attempt_label <> '' AND idempotency_digest ~ '^canonical-json/v1:[0-9a-f]{64}$'),
  CHECK ((status = 'failed') = (error IS NOT NULL)),
  CHECK (attempts >= 0 AND retry_limit >= 0 AND estimated_cost >= 0),
  CHECK ((status IN ('completed', 'failed')) = (ended_at IS NOT NULL)),
  CHECK ((status = 'claimed') = (lease_owner IS NOT NULL)),
  CHECK ((status = 'claimed') = (lease_expires_at IS NOT NULL))
);

CREATE TABLE observation.grading_provider_attempt (
  producer text NOT NULL,
  namespace text NOT NULL,
  execution_id text NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  run_id text NOT NULL,
  request_sent boolean NOT NULL DEFAULT false,
  outcome text CHECK (outcome IS NULL OR outcome IN ('completed', 'failed')),
  charged_cost double precision NOT NULL DEFAULT 0 CHECK (charged_cost >= 0),
  admitted_estimate double precision NOT NULL CHECK (admitted_estimate >= 0),
  cost_overage double precision NOT NULL DEFAULT 0 CHECK (cost_overage >= 0),
  provider_request_id text,
  failure_category text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (producer, namespace, execution_id, attempt),
  FOREIGN KEY (producer, namespace, execution_id)
    REFERENCES observation.evaluation_execution(producer, namespace, execution_id),
  CHECK (request_sent OR charged_cost = 0)
);

CREATE TABLE observation.grade_observation (
  producer text NOT NULL,
  namespace text NOT NULL,
  observation_id text NOT NULL,
  execution_id text NOT NULL,
  answer_kind text NOT NULL CHECK (answer_kind IN ('boolean', 'choice', 'ordinal', 'numeric', 'text', 'structured')),
  answer_state text NOT NULL CHECK (answer_state IN ('answered', 'abstain', 'unclear')),
  answer_payload jsonb NOT NULL,
  probabilities jsonb,
  confidence double precision,
  reviewer_id text,
  reviewer_details jsonb,
  comments text,
  rationale text,
  quality_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  supersedes_observation_id text,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (producer, namespace, observation_id),
  UNIQUE (producer, namespace, execution_id),
  FOREIGN KEY (producer, namespace, execution_id) REFERENCES observation.evaluation_execution(producer, namespace, execution_id),
  FOREIGN KEY (producer, namespace, supersedes_observation_id) REFERENCES observation.grade_observation(producer, namespace, observation_id),
  CHECK (jsonb_typeof(answer_payload) = 'object' AND jsonb_typeof(quality_flags) = 'array'),
  CHECK (answer_payload->>'kind' = answer_kind AND answer_payload->>'state' = answer_state),
  CHECK ((answer_state = 'answered' AND answer_payload ? 'value') OR
    (answer_state IN ('abstain', 'unclear') AND answer_payload ? 'reason' AND NOT (answer_payload ? 'value'))),
  CHECK (probabilities IS NULL OR jsonb_typeof(probabilities) = 'object'),
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CHECK (supersedes_observation_id IS NULL OR supersedes_observation_id <> observation_id)
);

CREATE TABLE observation.source_event_cursor (
  producer text NOT NULL,
  namespace text NOT NULL,
  commit_txid bigint NOT NULL DEFAULT 0,
  event_id text NOT NULL DEFAULT '',
  PRIMARY KEY (producer, namespace)
);

CREATE TABLE observation.source_event_outcome (
  producer text NOT NULL,
  namespace text NOT NULL,
  event_id text NOT NULL,
  run_id text NOT NULL,
  commit_txid bigint NOT NULL,
  event_kind text NOT NULL,
  outcome_kind text NOT NULL,
  detail jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (producer, namespace, event_id)
);

CREATE INDEX item_occurrence_run_page ON observation.item_occurrence(producer, namespace, run_id, revision_id, occurrence_id);
CREATE INDEX item_relation_source_occurrence ON observation.item_relation(producer, namespace, source_occurrence_id, relation_id);
CREATE INDEX item_relation_target_occurrence ON observation.item_relation(producer, namespace, target_occurrence_id, relation_id);
CREATE INDEX item_relation_source_logical ON observation.item_relation(producer, namespace, source_logical_item_id, relation_id);
CREATE INDEX item_relation_target_logical ON observation.item_relation(producer, namespace, target_logical_item_id, relation_id);
CREATE INDEX extraction_issue_revision ON observation.extraction_issue(producer, namespace, revision_id, issue_id);
CREATE INDEX grading_provider_attempt_spend ON observation.grading_provider_attempt(producer, namespace, run_id)
  INCLUDE (execution_id, attempt, charged_cost);
ALTER TABLE observation.source_revision
  ADD CONSTRAINT source_revision_predecessor_nonempty CHECK (predecessor_id IS NULL OR predecessor_id <> ''),
  ADD CONSTRAINT source_revision_subject_nonempty CHECK (subject_id IS NULL OR subject_id <> '');

CREATE FUNCTION observation.require_completed_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM observation.evaluation_execution x
    WHERE x.producer = NEW.producer AND x.namespace = NEW.namespace AND x.execution_id = NEW.execution_id
      AND x.status = 'completed') THEN
    RAISE EXCEPTION 'grade observation requires a completed execution';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER grade_observation_completed_execution BEFORE INSERT ON observation.grade_observation
  FOR EACH ROW EXECUTE FUNCTION observation.require_completed_execution();

CREATE FUNCTION observation.reject_grade_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'grade_observation is append-only';
END $$;
CREATE TRIGGER grade_observation_append_only BEFORE UPDATE OR DELETE ON observation.grade_observation
  FOR EACH ROW EXECUTE FUNCTION observation.reject_grade_mutation();

CREATE FUNCTION observation.reject_ready_evidence_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT OLD.is_incomplete THEN
    RAISE EXCEPTION 'ready evidence_set is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evidence_set_immutable BEFORE UPDATE ON observation.evidence_set
  FOR EACH ROW EXECUTE FUNCTION observation.reject_ready_evidence_update();

-- Every tenant-owned row is protected even when a query forgets its predicates.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['source_revision', 'extractor_definition', 'logical_item', 'item_occurrence', 'item_relation', 'extraction_issue', 'question_definition', 'evidence_set', 'evaluator_definition', 'evaluation_execution', 'grading_provider_attempt', 'grade_observation', 'source_event_cursor', 'source_event_outcome'] LOOP
    EXECUTE format('ALTER TABLE observation.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE observation.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON observation.%I USING (producer = current_setting(''observation.producer'', true) AND namespace = current_setting(''observation.namespace'', true)) WITH CHECK (producer = current_setting(''observation.producer'', true) AND namespace = current_setting(''observation.namespace'', true))', table_name || '_tenant', table_name);
  END LOOP;
END $$;
