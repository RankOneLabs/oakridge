-- Observation baseline. Apply only to an empty PostgreSQL 15+ database.
CREATE SCHEMA observation;

CREATE TABLE observation.schema_baseline (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Capture: one immutable copy of each producer artifact revision.
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
  CHECK (producer <> '' AND namespace <> '' AND revision_id <> ''),
  CHECK (predecessor_id IS NULL OR predecessor_id <> ''),
  CHECK (subject_id IS NULL OR subject_id <> '')
);

-- Projection: every tenant-owned reference retains the producer/namespace pair.
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
  json_pointer text NOT NULL,
  PRIMARY KEY (occurrence_id),
  UNIQUE (producer, namespace, occurrence_id),
  UNIQUE (producer, namespace, occurrence_id, run_id),
  UNIQUE (producer, namespace, revision_id, json_pointer),
  UNIQUE (producer, namespace, revision_id, extractor_id, extractor_version, item_selector, item_id_or_path),
  FOREIGN KEY (producer, namespace, revision_id)
    REFERENCES observation.source_revision(producer, namespace, revision_id),
  FOREIGN KEY (producer, namespace, artifact_kind, schema_version, extractor_id, extractor_version)
    REFERENCES observation.extractor_definition(producer, namespace, artifact_kind, schema_version, extractor_id, extractor_version),
  FOREIGN KEY (producer, namespace, logical_item_id)
    REFERENCES observation.logical_item(producer, namespace, logical_item_id),
  CHECK (occurrence_id ~ '^canonical-json/v1:[0-9a-f]{64}$'),
  CHECK (json_pointer <> '')
);
CREATE INDEX item_occurrence_run_page ON observation.item_occurrence(producer, namespace, run_id, revision_id, occurrence_id);
CREATE INDEX item_occurrence_logical ON observation.item_occurrence(producer, namespace, logical_item_id, occurrence_id);

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
CREATE INDEX item_relation_source_occurrence ON observation.item_relation(producer, namespace, source_occurrence_id, relation_id);
CREATE INDEX item_relation_target_occurrence ON observation.item_relation(producer, namespace, target_occurrence_id, relation_id);
CREATE INDEX item_relation_source_logical ON observation.item_relation(producer, namespace, source_logical_item_id, relation_id);
CREATE INDEX item_relation_target_logical ON observation.item_relation(producer, namespace, target_logical_item_id, relation_id);
CREATE INDEX item_relation_unresolved ON observation.item_relation(producer, namespace, unresolved_target_ref)
  WHERE unresolved_target_ref IS NOT NULL;

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
CREATE INDEX extraction_issue_revision ON observation.extraction_issue(producer, namespace, revision_id, issue_id);

-- Grading definitions are immutable under their natural keys, so a pin stays meaningful.
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
  CHECK (question_id <> '' AND question_version <> '' AND item_kind <> ''),
  CHECK (allowed_values IS NULL OR jsonb_typeof(allowed_values) = 'array'),
  CHECK (response_kind NOT IN ('choice', 'ordinal') OR (allowed_values IS NOT NULL AND jsonb_array_length(allowed_values) > 0))
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

-- One row per occurrence and question, written when the occurrence is captured. It is the
-- capture pin (the question version and evaluator set applicable to that occurrence) and the
-- question's readiness, and once ready it is the frozen evidence shared by every evaluator.
CREATE TABLE observation.evidence_set (
  producer text NOT NULL,
  namespace text NOT NULL,
  evidence_set_id text NOT NULL,
  subject_occurrence_id text NOT NULL,
  task_id text,
  question_id text NOT NULL,
  question_version text NOT NULL,
  pinned_evaluator_definition_ids text[] NOT NULL,
  readiness text NOT NULL CHECK (readiness IN ('not_ready', 'ready')),
  not_ready_code text,
  not_ready_detail text,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_incomplete boolean NOT NULL DEFAULT false,
  incompleteness_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ready_at timestamptz,
  PRIMARY KEY (producer, namespace, evidence_set_id),
  UNIQUE NULLS NOT DISTINCT (producer, namespace, subject_occurrence_id, task_id, question_id, question_version),
  UNIQUE (producer, namespace, evidence_set_id, subject_occurrence_id, question_id, question_version),
  UNIQUE (producer, namespace, evidence_set_id, subject_occurrence_id, task_id, question_id, question_version),
  FOREIGN KEY (producer, namespace, subject_occurrence_id)
    REFERENCES observation.item_occurrence(producer, namespace, occurrence_id),
  FOREIGN KEY (producer, namespace, task_id)
    REFERENCES observation.logical_item(producer, namespace, logical_item_id),
  FOREIGN KEY (producer, namespace, question_id, question_version)
    REFERENCES observation.question_definition(producer, namespace, question_id, question_version),
  CHECK (evidence_set_id ~ '^canonical-json/v1:[0-9a-f]{64}$'),
  CHECK (cardinality(pinned_evaluator_definition_ids) > 0),
  CHECK (jsonb_typeof(evidence_refs) = 'array'),
  CHECK ((readiness = 'ready') = (ready_at IS NOT NULL)),
  CHECK ((readiness = 'not_ready') = (not_ready_code IS NOT NULL AND not_ready_detail IS NOT NULL)),
  CHECK (readiness = 'not_ready' OR (not_ready_code IS NULL AND not_ready_detail IS NULL)),
  CHECK (readiness = 'ready' OR evidence_refs = '[]'::jsonb),
  CHECK (not_ready_code IS NULL OR (not_ready_code <> '' AND not_ready_detail <> '')),
  CHECK (is_incomplete = (incompleteness_reason IS NOT NULL)),
  CHECK (incompleteness_reason IS NULL OR incompleteness_reason <> '')
);
CREATE INDEX evidence_set_not_ready ON observation.evidence_set(producer, namespace, created_at, evidence_set_id)
  WHERE readiness = 'not_ready';

-- One measurement, and the only queue, lease and retry record. A human submission is one
-- completed execution whose attempt_label carries the submission id.
CREATE TABLE observation.evaluation_execution (
  producer text NOT NULL,
  namespace text NOT NULL,
  execution_id text NOT NULL,
  run_id text NOT NULL,
  subject_occurrence_id text NOT NULL,
  task_id text,
  evidence_set_id text NOT NULL,
  question_id text NOT NULL,
  question_version text NOT NULL,
  evaluator_definition_id text NOT NULL,
  attempt_label text NOT NULL,
  idempotency_digest text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'claimed', 'reclaimable', 'budget_deferred', 'completed', 'failed')),
  lease_owner text,
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  retries integer NOT NULL DEFAULT 0,
  retry_limit integer NOT NULL DEFAULT 0,
  estimated_cost double precision NOT NULL DEFAULT 0,
  terminal_cause text CHECK (terminal_cause IS NULL OR terminal_cause IN ('retry_exhausted', 'runner_failed', 'invalid_outcome')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  ended_at timestamptz,
  error text,
  model_usage jsonb,
  cost double precision,
  external_execution_id text,
  provider_link text,
  reproducibility_metadata jsonb,
  PRIMARY KEY (producer, namespace, execution_id),
  UNIQUE (producer, namespace, idempotency_digest),
  UNIQUE (producer, namespace, execution_id, run_id),
  FOREIGN KEY (producer, namespace, subject_occurrence_id, run_id)
    REFERENCES observation.item_occurrence(producer, namespace, occurrence_id, run_id),
  FOREIGN KEY (producer, namespace, evidence_set_id, subject_occurrence_id, task_id, question_id, question_version)
    REFERENCES observation.evidence_set(producer, namespace, evidence_set_id, subject_occurrence_id, task_id, question_id, question_version),
  FOREIGN KEY (producer, namespace, evidence_set_id, subject_occurrence_id, question_id, question_version)
    REFERENCES observation.evidence_set(producer, namespace, evidence_set_id, subject_occurrence_id, question_id, question_version),
  FOREIGN KEY (producer, namespace, task_id)
    REFERENCES observation.logical_item(producer, namespace, logical_item_id),
  FOREIGN KEY (producer, namespace, question_id, question_version)
    REFERENCES observation.question_definition(producer, namespace, question_id, question_version),
  FOREIGN KEY (producer, namespace, evaluator_definition_id)
    REFERENCES observation.evaluator_definition(producer, namespace, evaluator_definition_id),
  CHECK (attempt_label <> '' AND idempotency_digest ~ '^canonical-json/v1:[0-9a-f]{64}$'),
  CHECK (attempts >= 0 AND retries >= 0 AND retry_limit >= 0 AND estimated_cost >= 0),
  CHECK ((status = 'claimed') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (status = 'claimed' OR (lease_owner IS NULL AND lease_expires_at IS NULL)),
  CHECK ((status = 'failed') = (error IS NOT NULL)),
  CHECK ((status IN ('completed', 'failed')) = (ended_at IS NOT NULL)),
  CHECK (terminal_cause IS NULL OR status = 'failed')
);
CREATE INDEX evaluation_execution_claim ON observation.evaluation_execution(status, lease_expires_at, created_at)
  WHERE status IN ('queued', 'claimed', 'reclaimable');
CREATE INDEX evaluation_execution_subject ON observation.evaluation_execution(producer, namespace, subject_occurrence_id, task_id, question_id, question_version, created_at);
CREATE INDEX evaluation_execution_run ON observation.evaluation_execution(producer, namespace, run_id, status);

-- One real provider request. Request metadata stays separate from the measurement identity.
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
  FOREIGN KEY (producer, namespace, execution_id, run_id)
    REFERENCES observation.evaluation_execution(producer, namespace, execution_id, run_id),
  CHECK (request_sent OR charged_cost = 0)
);
CREATE INDEX grading_provider_attempt_spend ON observation.grading_provider_attempt(producer, namespace, run_id)
  INCLUDE (execution_id, attempt, charged_cost);

-- One append-only answer per execution. Subject, evidence, question and evaluator are read
-- through the execution; a correction is a later answer linked to the one it replaces.
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
  UNIQUE (producer, namespace, supersedes_observation_id),
  FOREIGN KEY (producer, namespace, execution_id)
    REFERENCES observation.evaluation_execution(producer, namespace, execution_id),
  FOREIGN KEY (producer, namespace, supersedes_observation_id)
    REFERENCES observation.grade_observation(producer, namespace, observation_id),
  CHECK (jsonb_typeof(answer_payload) = 'object' AND jsonb_typeof(quality_flags) = 'array'),
  CHECK (answer_payload->>'kind' = answer_kind AND answer_payload->>'state' = answer_state),
  CHECK ((answer_state = 'answered' AND answer_payload ? 'value') OR
    (answer_state IN ('abstain', 'unclear') AND answer_payload ? 'reason' AND NOT (answer_payload ? 'value'))),
  CHECK (probabilities IS NULL OR jsonb_typeof(probabilities) = 'object'),
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CHECK (reviewer_id IS NULL OR reviewer_id <> ''),
  CHECK (supersedes_observation_id IS NULL OR supersedes_observation_id <> observation_id)
);

-- Ordered source events: the cursor and each event's outcome commit together.
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
CREATE INDEX source_event_outcome_run ON observation.source_event_outcome(producer, namespace, run_id, outcome_kind);

-- Transaction-local tenant context is set by the storage adapter for every query.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['source_revision', 'extractor_definition', 'logical_item', 'item_occurrence',
    'item_relation', 'extraction_issue', 'question_definition', 'evaluator_definition', 'evidence_set',
    'evaluation_execution', 'grading_provider_attempt', 'grade_observation', 'source_event_cursor', 'source_event_outcome'] LOOP
    EXECUTE format('ALTER TABLE observation.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE observation.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON observation.%I USING (producer = current_setting(''observation.producer'', true) AND namespace = current_setting(''observation.namespace'', true)) WITH CHECK (producer = current_setting(''observation.producer'', true) AND namespace = current_setting(''observation.namespace'', true))', table_name || '_tenant', table_name);
  END LOOP;
END $$;

-- Captured sources, definitions and answers never change and are never removed.
CREATE FUNCTION observation.reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;
CREATE TRIGGER source_revision_append_only BEFORE UPDATE OR DELETE ON observation.source_revision
  FOR EACH ROW EXECUTE FUNCTION observation.reject_mutation();
CREATE TRIGGER item_occurrence_append_only BEFORE UPDATE OR DELETE ON observation.item_occurrence
  FOR EACH ROW EXECUTE FUNCTION observation.reject_mutation();
CREATE TRIGGER question_definition_append_only BEFORE UPDATE OR DELETE ON observation.question_definition
  FOR EACH ROW EXECUTE FUNCTION observation.reject_mutation();
CREATE TRIGGER evaluator_definition_append_only BEFORE UPDATE OR DELETE ON observation.evaluator_definition
  FOR EACH ROW EXECUTE FUNCTION observation.reject_mutation();
CREATE TRIGGER grade_observation_append_only BEFORE UPDATE OR DELETE ON observation.grade_observation
  FOR EACH ROW EXECUTE FUNCTION observation.reject_mutation();

-- A pin names a question for the subject's item kind and existing, distinct evaluators.
-- evaluator_definition is append-only, so a pinned definition cannot later disappear.
CREATE FUNCTION observation.require_valid_pin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM observation.item_occurrence i
    JOIN observation.question_definition q ON q.producer = i.producer AND q.namespace = i.namespace
      AND q.item_kind = i.item_kind
    WHERE i.producer = NEW.producer AND i.namespace = NEW.namespace AND i.occurrence_id = NEW.subject_occurrence_id
      AND q.question_id = NEW.question_id AND q.question_version = NEW.question_version) THEN
    RAISE EXCEPTION 'evidence set question does not apply to its subject item kind';
  END IF;
  IF (SELECT count(DISTINCT pin) FROM unnest(NEW.pinned_evaluator_definition_ids) AS pin) <> cardinality(NEW.pinned_evaluator_definition_ids) THEN
    RAISE EXCEPTION 'evidence set pins an evaluator twice';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(NEW.pinned_evaluator_definition_ids) AS pin
    WHERE NOT EXISTS (SELECT 1 FROM observation.evaluator_definition d
      WHERE d.producer = NEW.producer AND d.namespace = NEW.namespace AND d.evaluator_definition_id = pin)) THEN
    RAISE EXCEPTION 'evidence set pins an evaluator definition that does not exist';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evidence_set_valid_pin BEFORE INSERT ON observation.evidence_set
  FOR EACH ROW EXECUTE FUNCTION observation.require_valid_pin();

-- Only readiness may move, only forward. Ready evidence is frozen.
CREATE FUNCTION observation.guard_evidence_set() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'evidence_set is never removed'; END IF;
  IF OLD.readiness = 'ready' THEN RAISE EXCEPTION 'ready evidence_set is frozen'; END IF;
  IF (NEW.producer, NEW.namespace, NEW.evidence_set_id, NEW.subject_occurrence_id, NEW.task_id, NEW.question_id,
      NEW.question_version, NEW.pinned_evaluator_definition_ids, NEW.created_at)
    IS DISTINCT FROM (OLD.producer, OLD.namespace, OLD.evidence_set_id, OLD.subject_occurrence_id, OLD.task_id, OLD.question_id,
      OLD.question_version, OLD.pinned_evaluator_definition_ids, OLD.created_at) THEN
    RAISE EXCEPTION 'evidence_set pin is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evidence_set_guard BEFORE UPDATE OR DELETE ON observation.evidence_set
  FOR EACH ROW EXECUTE FUNCTION observation.guard_evidence_set();

-- An execution measures ready evidence with an evaluator pinned when the subject was captured.
CREATE FUNCTION observation.require_pinned_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM observation.evidence_set e
    WHERE e.producer = NEW.producer AND e.namespace = NEW.namespace AND e.evidence_set_id = NEW.evidence_set_id
      AND NEW.task_id IS NOT DISTINCT FROM e.task_id
      AND e.readiness = 'ready' AND NEW.evaluator_definition_id = ANY (e.pinned_evaluator_definition_ids)) THEN
    RAISE EXCEPTION 'execution requires ready evidence and a pinned evaluator';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evaluation_execution_pinned BEFORE INSERT ON observation.evaluation_execution
  FOR EACH ROW EXECUTE FUNCTION observation.require_pinned_execution();

-- Lifecycle fields move until the execution ends; its measurement identity never does.
CREATE FUNCTION observation.guard_evaluation_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'evaluation_execution is never removed'; END IF;
  IF OLD.status IN ('completed', 'failed') THEN RAISE EXCEPTION 'ended evaluation_execution is immutable'; END IF;
  IF (NEW.producer, NEW.namespace, NEW.execution_id, NEW.run_id, NEW.subject_occurrence_id, NEW.task_id, NEW.evidence_set_id,
      NEW.question_id, NEW.question_version, NEW.evaluator_definition_id, NEW.attempt_label, NEW.idempotency_digest)
    IS DISTINCT FROM (OLD.producer, OLD.namespace, OLD.execution_id, OLD.run_id, OLD.subject_occurrence_id, OLD.task_id, OLD.evidence_set_id,
      OLD.question_id, OLD.question_version, OLD.evaluator_definition_id, OLD.attempt_label, OLD.idempotency_digest) THEN
    RAISE EXCEPTION 'evaluation_execution identity is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evaluation_execution_guard BEFORE UPDATE OR DELETE ON observation.evaluation_execution
  FOR EACH ROW EXECUTE FUNCTION observation.guard_evaluation_execution();

-- An answer belongs to a completed execution of the matching response kind. A reviewer is
-- named exactly when the evaluator is human.
CREATE FUNCTION observation.require_completed_execution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE measured record;
BEGIN
  SELECT x.status, d.kind, q.response_kind INTO measured
    FROM observation.evaluation_execution x
    JOIN observation.evaluator_definition d ON d.producer = x.producer AND d.namespace = x.namespace
      AND d.evaluator_definition_id = x.evaluator_definition_id
    JOIN observation.question_definition q ON q.producer = x.producer AND q.namespace = x.namespace
      AND q.question_id = x.question_id AND q.question_version = x.question_version
    WHERE x.producer = NEW.producer AND x.namespace = NEW.namespace AND x.execution_id = NEW.execution_id;
  IF NOT FOUND OR measured.status <> 'completed' THEN
    RAISE EXCEPTION 'grade observation requires a completed execution';
  END IF;
  IF measured.response_kind <> NEW.answer_kind THEN
    RAISE EXCEPTION 'grade observation answer kind differs from its question';
  END IF;
  IF (measured.kind = 'human') <> (NEW.reviewer_id IS NOT NULL) THEN
    RAISE EXCEPTION 'grade observation reviewer must match its evaluator kind';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER grade_observation_completed_execution BEFORE INSERT ON observation.grade_observation
  FOR EACH ROW EXECUTE FUNCTION observation.require_completed_execution();

-- A correction re-measures the same occurrence, question, evidence and evaluator for the
-- same reviewer. The one-successor key keeps each correction history linear.
CREATE FUNCTION observation.require_correction_measurement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.supersedes_observation_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.reviewer_id IS NULL THEN RAISE EXCEPTION 'only a reviewer answer can be corrected'; END IF;
  IF NOT EXISTS (SELECT 1 FROM observation.grade_observation earlier
    JOIN observation.evaluation_execution earlier_x ON earlier_x.producer = earlier.producer
      AND earlier_x.namespace = earlier.namespace AND earlier_x.execution_id = earlier.execution_id
    JOIN observation.evaluation_execution x ON x.producer = NEW.producer AND x.namespace = NEW.namespace
      AND x.execution_id = NEW.execution_id
    WHERE earlier.producer = NEW.producer AND earlier.namespace = NEW.namespace
      AND earlier.observation_id = NEW.supersedes_observation_id AND earlier.reviewer_id = NEW.reviewer_id
      AND (x.subject_occurrence_id, x.evidence_set_id, x.question_id, x.question_version, x.evaluator_definition_id)
        = (earlier_x.subject_occurrence_id, earlier_x.evidence_set_id, earlier_x.question_id,
          earlier_x.question_version, earlier_x.evaluator_definition_id)) THEN
    RAISE EXCEPTION 'correction must address the same measurement and reviewer';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER grade_observation_correction BEFORE INSERT ON observation.grade_observation
  FOR EACH ROW EXECUTE FUNCTION observation.require_correction_measurement();
