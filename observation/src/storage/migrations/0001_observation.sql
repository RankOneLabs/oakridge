-- Observation L0 baseline. Apply only to an empty PostgreSQL 15+ database.
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

CREATE TABLE observation.ingest_receipt (
  producer text NOT NULL,
  namespace text NOT NULL,
  request_key text NOT NULL,
  revision_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('captured', 'revision_identity_conflict')),
  response jsonb NOT NULL,
  stored_digest text NOT NULL,
  incoming_digest text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (producer, namespace, request_key),
  FOREIGN KEY (producer, namespace, revision_id)
    REFERENCES observation.source_revision(producer, namespace, revision_id),
  CHECK (request_key <> '')
);

-- Transaction-local tenant context is set by the storage adapter for every query.
ALTER TABLE observation.source_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE observation.source_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY source_revision_tenant ON observation.source_revision
  USING (producer = current_setting('observation.producer', true)
    AND namespace = current_setting('observation.namespace', true))
  WITH CHECK (producer = current_setting('observation.producer', true)
    AND namespace = current_setting('observation.namespace', true));
ALTER TABLE observation.ingest_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE observation.ingest_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY ingest_receipt_tenant ON observation.ingest_receipt
  USING (producer = current_setting('observation.producer', true)
    AND namespace = current_setting('observation.namespace', true))
  WITH CHECK (producer = current_setting('observation.producer', true)
    AND namespace = current_setting('observation.namespace', true));

-- L1 projection. Every tenant-owned reference retains the L0 producer/namespace pair.
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
CREATE INDEX item_occurrence_run_page ON observation.item_occurrence(producer, namespace, run_id, revision_id, occurrence_id);

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

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['extractor_definition', 'logical_item', 'item_occurrence', 'item_relation', 'extraction_issue'] LOOP
    EXECUTE format('ALTER TABLE observation.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE observation.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON observation.%I USING (producer = current_setting(''observation.producer'', true) AND namespace = current_setting(''observation.namespace'', true)) WITH CHECK (producer = current_setting(''observation.producer'', true) AND namespace = current_setting(''observation.namespace'', true))', table_name || '_tenant', table_name);
  END LOOP;
END $$;

-- Producer revision links must be non-empty when present.
ALTER TABLE observation.source_revision
  ADD CONSTRAINT source_revision_predecessor_nonempty CHECK (predecessor_id IS NULL OR predecessor_id <> ''),
  ADD CONSTRAINT source_revision_subject_nonempty CHECK (subject_id IS NULL OR subject_id <> '');

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
  question_text text,
  evidence_recipe_provenance jsonb,
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
  provider_attempts jsonb NOT NULL DEFAULT '[]'::jsonb,
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
  label_origin text GENERATED ALWAYS AS (
  CASE
    WHEN question_id LIKE 'oakridge-review:%' AND question_version = '1'
      AND evaluator_definition_id = 'oakridge-operator-human'
      AND reviewer_id = 'oakridge-operator' THEN 'oakridge_operator_unblinded'
    ELSE 'other'
  END
) STORED,
  collection_mode text CHECK (collection_mode IN ('blind', 'in_context')),
  blind_assignment_id text,
  model_answers_visible boolean,
  workflow_decisions_visible boolean,
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

CREATE TABLE observation.source_human_grade (
  producer text NOT NULL,
  namespace text NOT NULL,
  event_id text NOT NULL,
  run_id text NOT NULL,
  unit_id text NOT NULL,
  review text NOT NULL,
  decision text NOT NULL,
  target_revision_id text NOT NULL,
  evaluator_kind text NOT NULL CHECK (evaluator_kind = 'human'),
  feedback jsonb,
  PRIMARY KEY (producer, namespace, event_id),
  FOREIGN KEY (producer, namespace, event_id) REFERENCES observation.source_event_outcome(producer, namespace, event_id)
);

ALTER TABLE observation.source_event_cursor ENABLE ROW LEVEL SECURITY;
ALTER TABLE observation.source_event_cursor FORCE ROW LEVEL SECURITY;
CREATE POLICY source_event_cursor_tenant ON observation.source_event_cursor
  USING (producer = current_setting('observation.producer', true) AND namespace = current_setting('observation.namespace', true))
  WITH CHECK (producer = current_setting('observation.producer', true) AND namespace = current_setting('observation.namespace', true));
ALTER TABLE observation.source_event_outcome ENABLE ROW LEVEL SECURITY;
ALTER TABLE observation.source_event_outcome FORCE ROW LEVEL SECURITY;
CREATE POLICY source_event_outcome_tenant ON observation.source_event_outcome
  USING (producer = current_setting('observation.producer', true) AND namespace = current_setting('observation.namespace', true))
  WITH CHECK (producer = current_setting('observation.producer', true) AND namespace = current_setting('observation.namespace', true));
ALTER TABLE observation.source_human_grade ENABLE ROW LEVEL SECURITY;
ALTER TABLE observation.source_human_grade FORCE ROW LEVEL SECURITY;
CREATE POLICY source_human_grade_tenant ON observation.source_human_grade
  USING (producer = current_setting('observation.producer', true) AND namespace = current_setting('observation.namespace', true))
  WITH CHECK (producer = current_setting('observation.producer', true) AND namespace = current_setting('observation.namespace', true));

-- L3: one immutable export and one frozen row per candidate considered.
CREATE TABLE observation.export_manifest (
  producer text NOT NULL,
  namespace text NOT NULL,
  manifest_id text NOT NULL,
  frozen_at timestamptz NOT NULL,
  membership_digest text NOT NULL CHECK (membership_digest ~ '^canonical-json/v1:[0-9a-f]{64}$'),
  format_version text NOT NULL CHECK (format_version = 'assay-jsonl/v1'),
  redaction_policy jsonb NOT NULL CHECK (jsonb_typeof(redaction_policy) = 'object'),
  file_hashes jsonb NOT NULL CHECK (jsonb_typeof(file_hashes) = 'object'),
  PRIMARY KEY (producer, namespace, manifest_id),
  CHECK (producer <> '' AND namespace <> '' AND manifest_id <> '')
);

CREATE TABLE observation.export_membership (
  producer text NOT NULL,
  namespace text NOT NULL,
  manifest_id text NOT NULL,
  candidate_id text NOT NULL CHECK (candidate_id ~ '^canonical-json/v1:[0-9a-f]{64}$'),
  occurrence_id text NOT NULL,
  revision_id text NOT NULL,
  revision_digest text NOT NULL CHECK (revision_digest ~ '^canonical-json/v1:[0-9a-f]{64}$'),
  evidence_set_id text,
  evidence_set_digest text CHECK (evidence_set_digest IS NULL OR evidence_set_digest ~ '^canonical-json/v1:[0-9a-f]{64}$'),
  observation_id text,
  disposition text NOT NULL CHECK (disposition IN ('included', 'excluded')),
  reason text NOT NULL CHECK (reason <> ''),
  redaction_reasons jsonb NOT NULL CHECK (jsonb_typeof(redaction_reasons) = 'array'),
  PRIMARY KEY (producer, namespace, manifest_id, candidate_id),
  FOREIGN KEY (producer, namespace, manifest_id) REFERENCES observation.export_manifest(producer, namespace, manifest_id),
  FOREIGN KEY (producer, namespace, occurrence_id) REFERENCES observation.item_occurrence(producer, namespace, occurrence_id),
  FOREIGN KEY (producer, namespace, revision_id) REFERENCES observation.source_revision(producer, namespace, revision_id),
  FOREIGN KEY (producer, namespace, evidence_set_id) REFERENCES observation.evidence_set(producer, namespace, evidence_set_id),
  FOREIGN KEY (producer, namespace, observation_id) REFERENCES observation.grade_observation(producer, namespace, observation_id),
  CHECK ((evidence_set_id IS NULL) = (evidence_set_digest IS NULL)),
  CHECK (observation_id IS NULL OR evidence_set_id IS NOT NULL)
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['export_manifest', 'export_membership'] LOOP
    EXECUTE format('ALTER TABLE observation.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE observation.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON observation.%I USING (producer = current_setting(''observation.producer'', true) AND namespace = current_setting(''observation.namespace'', true)) WITH CHECK (producer = current_setting(''observation.producer'', true) AND namespace = current_setting(''observation.namespace'', true))', table_name || '_tenant', table_name);
  END LOOP;
END $$;

CREATE FUNCTION observation.reject_export_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'export manifest is immutable';
END $$;
CREATE TRIGGER export_manifest_immutable BEFORE UPDATE OR DELETE ON observation.export_manifest
  FOR EACH ROW EXECUTE FUNCTION observation.reject_export_mutation();
CREATE TRIGGER export_membership_immutable BEFORE UPDATE OR DELETE ON observation.export_membership
  FOR EACH ROW EXECUTE FUNCTION observation.reject_export_mutation();

CREATE FUNCTION observation.require_new_export_manifest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM observation.export_manifest m
    WHERE m.producer = NEW.producer AND m.namespace = NEW.namespace AND m.manifest_id = NEW.manifest_id
      AND m.xmin::text = pg_current_xact_id()::text) THEN
    RAISE EXCEPTION 'export membership can only be written with its new manifest';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER export_membership_same_transaction BEFORE INSERT ON observation.export_membership
  FOR EACH ROW EXECUTE FUNCTION observation.require_new_export_manifest();

-- Compare both transaction ids in the 32-bit xid domain used by xmin. xid8
-- retains the epoch, so a direct text comparison fails after the first wrap.
CREATE OR REPLACE FUNCTION observation.require_new_export_manifest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM observation.export_manifest m
    WHERE m.producer = NEW.producer AND m.namespace = NEW.namespace AND m.manifest_id = NEW.manifest_id
      AND m.xmin::text::bigint = mod(pg_current_xact_id()::text::numeric, 4294967296)::bigint) THEN
    RAISE EXCEPTION 'export membership can only be written with its new manifest';
  END IF;
  RETURN NEW;
END $$;

-- Frozen manifests retain their identity snapshots after an explicitly overridden purge.
-- Membership is immutable; its IDs remain auditable even when source rows are removed.

DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT c.conname FROM pg_constraint c
    WHERE c.conrelid = 'observation.export_membership'::regclass AND c.contype = 'f'
      AND c.confrelid IN ('observation.item_occurrence'::regclass,
        'observation.source_revision'::regclass, 'observation.evidence_set'::regclass,
        'observation.grade_observation'::regclass)
  LOOP
    EXECUTE format('ALTER TABLE observation.export_membership DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

-- Frozen membership keeps historical IDs after an overridden purge. New
-- membership still needs every referenced row to exist when it is written.
-- The run advisory lock serializes a freeze with purge's frozen-membership
-- check. KEY SHARE then prevents concurrent deletion of referenced rows.
CREATE FUNCTION observation.require_export_membership_references() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE membership_run_id text;
BEGIN
  SELECT run_id INTO membership_run_id FROM observation.item_occurrence
    WHERE producer = NEW.producer AND namespace = NEW.namespace AND occurrence_id = NEW.occurrence_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'export membership occurrence does not exist' USING ERRCODE = '23503'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW.producer || ':' || NEW.namespace || ':purge:' || membership_run_id, 0));
  PERFORM 1 FROM observation.item_occurrence
    WHERE producer = NEW.producer AND namespace = NEW.namespace AND occurrence_id = NEW.occurrence_id
      AND run_id = membership_run_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'export membership occurrence does not exist' USING ERRCODE = '23503'; END IF;
  PERFORM 1 FROM observation.source_revision
    WHERE producer = NEW.producer AND namespace = NEW.namespace AND revision_id = NEW.revision_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'export membership revision does not exist' USING ERRCODE = '23503'; END IF;
  IF NEW.evidence_set_id IS NOT NULL THEN
    PERFORM 1 FROM observation.evidence_set
      WHERE producer = NEW.producer AND namespace = NEW.namespace AND evidence_set_id = NEW.evidence_set_id FOR KEY SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'export membership evidence set does not exist' USING ERRCODE = '23503'; END IF;
  END IF;
  IF NEW.observation_id IS NOT NULL THEN
    PERFORM 1 FROM observation.grade_observation
      WHERE producer = NEW.producer AND namespace = NEW.namespace AND observation_id = NEW.observation_id FOR KEY SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'export membership grade observation does not exist' USING ERRCODE = '23503'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER export_membership_references BEFORE INSERT ON observation.export_membership
  FOR EACH ROW EXECUTE FUNCTION observation.require_export_membership_references();

-- The dropped foreign keys must not make ordinary source mutation able to
-- orphan a frozen member. Only the named run in an overridden purge may do so.
CREATE FUNCTION observation.protect_export_membership_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE has_membership boolean;
DECLARE source_run_id text;
BEGIN
  IF TG_TABLE_NAME = 'item_occurrence' THEN
    IF TG_OP = 'UPDATE' AND (OLD.producer, OLD.namespace, OLD.occurrence_id)
        IS NOT DISTINCT FROM (NEW.producer, NEW.namespace, NEW.occurrence_id) THEN RETURN NEW; END IF;
    SELECT EXISTS (SELECT 1 FROM observation.export_membership m
      WHERE m.producer = OLD.producer AND m.namespace = OLD.namespace
        AND m.occurrence_id = OLD.occurrence_id) INTO has_membership;
    source_run_id := OLD.run_id;
  ELSIF TG_TABLE_NAME = 'source_revision' THEN
    IF TG_OP = 'UPDATE' AND (OLD.producer, OLD.namespace, OLD.revision_id)
        IS NOT DISTINCT FROM (NEW.producer, NEW.namespace, NEW.revision_id) THEN RETURN NEW; END IF;
    SELECT EXISTS (SELECT 1 FROM observation.export_membership m
      WHERE m.producer = OLD.producer AND m.namespace = OLD.namespace
        AND m.revision_id = OLD.revision_id) INTO has_membership;
    source_run_id := OLD.run_id;
  ELSIF TG_TABLE_NAME = 'evidence_set' THEN
    IF TG_OP = 'UPDATE' AND (OLD.producer, OLD.namespace, OLD.evidence_set_id)
        IS NOT DISTINCT FROM (NEW.producer, NEW.namespace, NEW.evidence_set_id) THEN RETURN NEW; END IF;
    SELECT EXISTS (SELECT 1 FROM observation.export_membership m
      WHERE m.producer = OLD.producer AND m.namespace = OLD.namespace
        AND m.evidence_set_id = OLD.evidence_set_id) INTO has_membership;
  ELSIF TG_TABLE_NAME = 'grade_observation' THEN
    IF TG_OP = 'UPDATE' AND (OLD.producer, OLD.namespace, OLD.observation_id)
        IS NOT DISTINCT FROM (NEW.producer, NEW.namespace, NEW.observation_id) THEN RETURN NEW; END IF;
    SELECT EXISTS (SELECT 1 FROM observation.export_membership m
      WHERE m.producer = OLD.producer AND m.namespace = OLD.namespace
        AND m.observation_id = OLD.observation_id) INTO has_membership;
    SELECT i.run_id INTO source_run_id FROM observation.item_occurrence i
      WHERE i.producer = OLD.producer AND i.namespace = OLD.namespace
        AND i.occurrence_id = OLD.subject_occurrence_id;
  END IF;
  IF has_membership AND NOT (TG_OP = 'DELETE' AND TG_TABLE_NAME <> 'evidence_set'
    AND COALESCE(current_setting('observation.purge_override', true) = 'true', false)
    AND source_run_id = current_setting('observation.purge_run', true)) THEN
    RAISE EXCEPTION 'frozen export membership protects source row' USING ERRCODE = '23503';
  END IF;
  IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER export_occurrence_source_guard BEFORE UPDATE OF producer, namespace, occurrence_id OR DELETE
  ON observation.item_occurrence FOR EACH ROW EXECUTE FUNCTION observation.protect_export_membership_source();
CREATE TRIGGER export_revision_source_guard BEFORE UPDATE OF producer, namespace, revision_id OR DELETE
  ON observation.source_revision FOR EACH ROW EXECUTE FUNCTION observation.protect_export_membership_source();
CREATE TRIGGER export_evidence_source_guard BEFORE UPDATE OF producer, namespace, evidence_set_id OR DELETE
  ON observation.evidence_set FOR EACH ROW EXECUTE FUNCTION observation.protect_export_membership_source();
CREATE TRIGGER export_grade_source_guard BEFORE UPDATE OF producer, namespace, observation_id OR DELETE
  ON observation.grade_observation FOR EACH ROW EXECUTE FUNCTION observation.protect_export_membership_source();

CREATE TABLE observation.purge_event (
  producer text NOT NULL,
  namespace text NOT NULL,
  purge_id text NOT NULL,
  run_id text NOT NULL,
  trigger_event_id text NOT NULL,
  trigger_run_key text NOT NULL,
  operator_override boolean NOT NULL,
  frozen_manifest_ids jsonb NOT NULL CHECK (jsonb_typeof(frozen_manifest_ids) = 'array'),
  source_revisions_removed integer NOT NULL,
  item_occurrences_removed integer NOT NULL,
  item_relations_removed integer NOT NULL,
  extraction_issues_removed integer NOT NULL,
  evaluation_executions_removed integer NOT NULL,
  grade_observations_removed integer NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (producer, namespace, purge_id),
  UNIQUE (producer, namespace, trigger_event_id)
);
CREATE TABLE observation.source_operator_cursor (
  producer text NOT NULL,
  namespace text NOT NULL,
  commit_txid bigint NOT NULL DEFAULT 0,
  event_id text NOT NULL DEFAULT '',
  PRIMARY KEY (producer, namespace)
);
CREATE TABLE observation.source_backfill_position (
  producer text NOT NULL,
  namespace text NOT NULL,
  position jsonb NOT NULL CHECK (jsonb_typeof(position) = 'object'),
  counts jsonb NOT NULL CHECK (jsonb_typeof(counts) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (producer, namespace)
);
CREATE TABLE observation.source_collaboration_comment (
  producer text NOT NULL,
  namespace text NOT NULL,
  message_id text NOT NULL,
  thread_id text NOT NULL,
  run_id text NOT NULL,
  unit_id text NOT NULL,
  revision_id text,
  anchor text,
  title text NOT NULL,
  body jsonb NOT NULL,
  occurrence_id text,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (producer, namespace, message_id),
  FOREIGN KEY (producer, namespace, occurrence_id)
    REFERENCES observation.item_occurrence(producer, namespace, occurrence_id)
);
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['source_backfill_position', 'source_collaboration_comment'] LOOP
    EXECUTE format('ALTER TABLE observation.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE observation.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON observation.%I USING (producer = current_setting(''observation.producer'', true) AND namespace = current_setting(''observation.namespace'', true)) WITH CHECK (producer = current_setting(''observation.producer'', true) AND namespace = current_setting(''observation.namespace'', true))', table_name || '_tenant', table_name);
  END LOOP;
END $$;
ALTER TABLE observation.source_operator_cursor ENABLE ROW LEVEL SECURITY;
ALTER TABLE observation.source_operator_cursor FORCE ROW LEVEL SECURITY;
CREATE POLICY source_operator_cursor_tenant ON observation.source_operator_cursor
  USING (producer = current_setting('observation.producer', true) AND namespace = current_setting('observation.namespace', true))
  WITH CHECK (producer = current_setting('observation.producer', true) AND namespace = current_setting('observation.namespace', true));
ALTER TABLE observation.purge_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE observation.purge_event FORCE ROW LEVEL SECURITY;
CREATE POLICY purge_event_tenant ON observation.purge_event
  USING (producer = current_setting('observation.producer', true) AND namespace = current_setting('observation.namespace', true))
  WITH CHECK (producer = current_setting('observation.producer', true) AND namespace = current_setting('observation.namespace', true));

-- The ordinary grade contract remains append-only. Only the purge transaction
-- may authorize removal, and the audit insert must commit in that transaction.
CREATE OR REPLACE FUNCTION observation.reject_grade_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND EXISTS (
    SELECT 1 FROM observation.item_occurrence i
    WHERE i.producer = OLD.producer AND i.namespace = OLD.namespace
      AND i.occurrence_id = OLD.subject_occurrence_id
      AND i.run_id = current_setting('observation.purge_run', true)
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'grade_observation is append-only';
END $$;

CREATE TABLE observation.evaluation_eligibility (
  producer text NOT NULL,
  namespace text NOT NULL,
  subject_occurrence_id text NOT NULL,
  question_id text NOT NULL,
  question_version text NOT NULL,
  tag text NOT NULL CHECK (tag IN ('eligible', 'inapplicable', 'missing_evidence', 'invalid_reference', 'blocked_dependency', 'skipped_budget')),
  payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  eligibility_id text NOT NULL DEFAULT gen_random_uuid()::text,
  PRIMARY KEY (producer, namespace, eligibility_id),
  FOREIGN KEY (producer, namespace, subject_occurrence_id) REFERENCES observation.item_occurrence(producer, namespace, occurrence_id),
  FOREIGN KEY (producer, namespace, question_id, question_version) REFERENCES observation.question_definition(producer, namespace, question_id, question_version),
  CHECK (jsonb_typeof(payload) = 'object'),
  CHECK (tag <> 'invalid_reference' OR payload->>'kind' IN ('dangling_citation', 'unlinked')),
  CHECK (tag <> 'skipped_budget' OR payload->>'kind' = 'skipped_budget')
);
ALTER TABLE observation.evaluation_eligibility ENABLE ROW LEVEL SECURITY;
ALTER TABLE observation.evaluation_eligibility FORCE ROW LEVEL SECURITY;
CREATE POLICY evaluation_eligibility_tenant ON observation.evaluation_eligibility
  USING (producer = current_setting('observation.producer', true) AND namespace = current_setting('observation.namespace', true))
  WITH CHECK (producer = current_setting('observation.producer', true) AND namespace = current_setting('observation.namespace', true));
CREATE TRIGGER evaluation_eligibility_append_only BEFORE UPDATE OR DELETE ON observation.evaluation_eligibility
  FOR EACH ROW EXECUTE FUNCTION observation.reject_grade_mutation();

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
  terminal_cause text CHECK (terminal_cause IS NULL OR terminal_cause IN ('retry_exhausted', 'runner_failed', 'disclosure_refused', 'invalid_outcome', 'ineligible', 'budget_exceeded')),
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

CREATE TABLE observation.blind_assignment (
  producer text NOT NULL,
  namespace text NOT NULL,
  assignment_id text NOT NULL,
  subject_occurrence_id text NOT NULL,
  evidence_set_id text NOT NULL,
  question_id text NOT NULL,
  question_version text NOT NULL,
  claim_owner text,
  claimed_at timestamptz,
  expires_at timestamptz,
  submitted_observation_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (producer, namespace, assignment_id),
  UNIQUE (producer, namespace, subject_occurrence_id, question_id, question_version),
  FOREIGN KEY (producer, namespace, subject_occurrence_id) REFERENCES observation.item_occurrence(producer, namespace, occurrence_id),
  FOREIGN KEY (producer, namespace, evidence_set_id) REFERENCES observation.evidence_set(producer, namespace, evidence_set_id),
  FOREIGN KEY (producer, namespace, question_id, question_version) REFERENCES observation.question_definition(producer, namespace, question_id, question_version),
  FOREIGN KEY (producer, namespace, submitted_observation_id) REFERENCES observation.grade_observation(producer, namespace, observation_id),
  CHECK ((claim_owner IS NULL) = (claimed_at IS NULL AND expires_at IS NULL)),
  CHECK (submitted_observation_id IS NULL OR claim_owner IS NOT NULL),
  CHECK (expires_at IS NULL OR expires_at > claimed_at)
);
ALTER TABLE observation.grade_observation
  ADD CONSTRAINT grade_blind_assignment_ref FOREIGN KEY (producer, namespace, blind_assignment_id)
    REFERENCES observation.blind_assignment(producer, namespace, assignment_id),
  ADD CONSTRAINT grade_collection_consistency CHECK (
    collection_mode IS NULL OR
    (model_answers_visible IS NOT NULL AND workflow_decisions_visible IS NOT NULL AND
      (collection_mode <> 'blind' OR (blind_assignment_id IS NOT NULL
        AND NOT model_answers_visible AND NOT workflow_decisions_visible))));
ALTER TABLE observation.blind_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE observation.blind_assignment FORCE ROW LEVEL SECURITY;
CREATE POLICY blind_assignment_tenant ON observation.blind_assignment
  USING (producer = current_setting('observation.producer', true) AND namespace = current_setting('observation.namespace', true))
  WITH CHECK (producer = current_setting('observation.producer', true) AND namespace = current_setting('observation.namespace', true));
