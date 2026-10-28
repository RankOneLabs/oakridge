-- L2 grading: identities are relational and every tenant-owned reference carries its scope.
CREATE TABLE observation.question_definition (
  producer text NOT NULL,
  namespace text NOT NULL,
  question_id text NOT NULL,
  question_version text NOT NULL,
  target_item_kinds jsonb NOT NULL,
  input_recipe jsonb NOT NULL,
  response_kind text NOT NULL CHECK (response_kind IN ('boolean', 'choice', 'ordinal', 'numeric', 'text', 'structured')),
  allowed_values jsonb,
  missing_evidence_policy text NOT NULL CHECK (missing_evidence_policy IN ('fail', 'abstain')),
  abstain_semantics text NOT NULL,
  unclear_semantics text NOT NULL,
  interpretation_caveats text NOT NULL,
  requires_repository_snapshot boolean NOT NULL,
  PRIMARY KEY (producer, namespace, question_id, question_version),
  CHECK (question_id <> '' AND question_version <> ''),
  CHECK (jsonb_typeof(target_item_kinds) = 'array' AND jsonb_array_length(target_item_kinds) > 0),
  CHECK (jsonb_typeof(input_recipe) = 'object'),
  CHECK (allowed_values IS NULL OR jsonb_typeof(allowed_values) = 'array'),
  CHECK (response_kind NOT IN ('choice', 'ordinal') OR (allowed_values IS NOT NULL AND jsonb_array_length(allowed_values) > 0))
);

CREATE TABLE observation.evidence_set (
  producer text NOT NULL,
  namespace text NOT NULL,
  evidence_set_id text NOT NULL,
  evidence_refs jsonb NOT NULL,
  is_incomplete boolean NOT NULL,
  incompleteness_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (producer, namespace, evidence_set_id),
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
  config_digest text NOT NULL,
  attempt_label text NOT NULL,
  idempotency_digest text NOT NULL,
  attempts integer NOT NULL DEFAULT 1,
  retries integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  error text,
  model_usage jsonb,
  cost double precision,
  external_execution_id text,
  provider_link text,
  reproducibility_metadata jsonb,
  PRIMARY KEY (producer, namespace, execution_id),
  UNIQUE (producer, namespace, idempotency_digest),
  UNIQUE (producer, namespace, execution_id, subject_occurrence_id, evidence_set_id, question_id, question_version, evaluator_definition_id),
  FOREIGN KEY (producer, namespace, subject_occurrence_id) REFERENCES observation.item_occurrence(producer, namespace, occurrence_id),
  FOREIGN KEY (producer, namespace, evidence_set_id) REFERENCES observation.evidence_set(producer, namespace, evidence_set_id),
  FOREIGN KEY (producer, namespace, question_id, question_version) REFERENCES observation.question_definition(producer, namespace, question_id, question_version),
  FOREIGN KEY (producer, namespace, evaluator_definition_id) REFERENCES observation.evaluator_definition(producer, namespace, evaluator_definition_id),
  CHECK (attempt_label <> '' AND idempotency_digest ~ '^canonical-json/v1:[0-9a-f]{64}$'),
  CHECK (attempts > 0 AND retries >= 0 AND retries < attempts),
  CHECK ((status = 'failed') = (error IS NOT NULL)),
  CHECK (status = 'running' OR ended_at IS NOT NULL)
);

CREATE TABLE observation.grade_observation (
  producer text NOT NULL,
  namespace text NOT NULL,
  observation_id text NOT NULL,
  execution_id text NOT NULL,
  subject_occurrence_id text NOT NULL,
  evidence_set_id text NOT NULL,
  question_id text NOT NULL,
  question_version text NOT NULL,
  evaluator_definition_id text NOT NULL,
  answer_kind text NOT NULL CHECK (answer_kind IN ('boolean', 'choice', 'ordinal', 'numeric', 'text', 'structured')),
  answer_state text NOT NULL CHECK (answer_state IN ('answered', 'abstain', 'unclear')),
  answer_payload jsonb NOT NULL,
  probabilities jsonb,
  confidence double precision,
  normalized_score double precision,
  decision_policy_id text,
  decision_policy_version text,
  reviewer_id text,
  reviewer_details jsonb,
  comments text,
  rationale text,
  quality_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  supersedes_observation_id text,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (producer, namespace, observation_id),
  UNIQUE (producer, namespace, observation_id, subject_occurrence_id, question_id, question_version),
  UNIQUE (producer, namespace, execution_id),
  FOREIGN KEY (producer, namespace, execution_id, subject_occurrence_id, evidence_set_id, question_id, question_version, evaluator_definition_id)
    REFERENCES observation.evaluation_execution(producer, namespace, execution_id, subject_occurrence_id, evidence_set_id, question_id, question_version, evaluator_definition_id),
  FOREIGN KEY (producer, namespace, supersedes_observation_id, subject_occurrence_id, question_id, question_version)
    REFERENCES observation.grade_observation(producer, namespace, observation_id, subject_occurrence_id, question_id, question_version),
  CHECK (jsonb_typeof(answer_payload) = 'object' AND jsonb_typeof(quality_flags) = 'array'),
  CHECK (answer_payload->>'kind' = answer_kind AND answer_payload->>'state' = answer_state),
  CHECK ((answer_state = 'answered' AND answer_payload ? 'value') OR
    (answer_state IN ('abstain', 'unclear') AND answer_payload ? 'reason' AND NOT (answer_payload ? 'value'))),
  CHECK (probabilities IS NULL OR jsonb_typeof(probabilities) = 'object'),
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CHECK ((normalized_score IS NULL AND decision_policy_id IS NULL AND decision_policy_version IS NULL) OR
    (normalized_score IS NOT NULL AND decision_policy_id IS NOT NULL AND decision_policy_version IS NOT NULL)),
  CHECK (decision_policy_id IS NULL OR (decision_policy_id <> '' AND decision_policy_version <> '')),
  CHECK (supersedes_observation_id IS NULL OR supersedes_observation_id <> observation_id)
);
CREATE INDEX grade_observation_subject_page ON observation.grade_observation(producer, namespace, subject_occurrence_id, recorded_at, observation_id);

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

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['question_definition', 'evidence_set', 'evaluator_definition', 'evaluation_execution', 'grade_observation'] LOOP
    EXECUTE format('ALTER TABLE observation.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE observation.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON observation.%I USING (producer = current_setting(''observation.producer'', true) AND namespace = current_setting(''observation.namespace'', true)) WITH CHECK (producer = current_setting(''observation.producer'', true) AND namespace = current_setting(''observation.namespace'', true))', table_name || '_tenant', table_name);
  END LOOP;
END $$;

CREATE FUNCTION observation.reject_grade_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'grade_observation is append-only';
END $$;
CREATE TRIGGER grade_observation_append_only BEFORE UPDATE OR DELETE ON observation.grade_observation
  FOR EACH ROW EXECUTE FUNCTION observation.reject_grade_mutation();
