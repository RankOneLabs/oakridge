-- Langfuse projection identity and inbound history are separate from local grading.
CREATE TABLE observation.langfuse_mapping (
  producer text NOT NULL,
  namespace text NOT NULL,
  mapping_key text NOT NULL CHECK (mapping_key ~ '^canonical-json/v1:[0-9a-f]{64}$'),
  occurrence_id text NOT NULL,
  evidence_set_id text NOT NULL,
  evidence_set_digest text NOT NULL CHECK (evidence_set_digest ~ '^canonical-json/v1:[0-9a-f]{64}$'),
  question_id text NOT NULL,
  question_version text NOT NULL,
  projection_version text NOT NULL,
  execution_id text NOT NULL,
  attempt_id text NOT NULL,
  trace_id text,
  observation_id text,
  score_id text,
  queue_item_id text,
  sync_state text NOT NULL CHECK (sync_state IN ('queued', 'pending', 'completed', 'failed', 'timed_out', 'unmatched', 'stale')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (producer, namespace, mapping_key),
  CHECK (producer <> '' AND namespace <> '' AND occurrence_id <> '' AND evidence_set_id <> ''),
  CHECK (question_id <> '' AND question_version <> '' AND projection_version <> '' AND execution_id <> '' AND attempt_id <> ''),
  CHECK ((trace_id IS NULL AND observation_id IS NULL AND score_id IS NULL AND queue_item_id IS NULL)
    OR (trace_id IS NOT NULL AND observation_id IS NOT NULL AND score_id IS NOT NULL AND queue_item_id IS NOT NULL))
);

CREATE TABLE observation.langfuse_sync_transition (
  producer text NOT NULL,
  namespace text NOT NULL,
  transition_id text NOT NULL DEFAULT gen_random_uuid()::text,
  mapping_key text NOT NULL,
  from_state text CHECK (from_state IS NULL OR from_state IN ('queued', 'pending', 'completed', 'failed', 'timed_out', 'unmatched', 'stale')),
  to_state text NOT NULL CHECK (to_state IN ('queued', 'pending', 'completed', 'failed', 'timed_out', 'unmatched', 'stale')),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (producer, namespace, transition_id),
  FOREIGN KEY (producer, namespace, mapping_key) REFERENCES observation.langfuse_mapping(producer, namespace, mapping_key)
);
CREATE INDEX langfuse_sync_transition_mapping ON observation.langfuse_sync_transition(producer, namespace, mapping_key, recorded_at, transition_id);

CREATE TABLE observation.langfuse_inbound_quarantine (
  producer text NOT NULL,
  namespace text NOT NULL,
  quarantine_id text NOT NULL DEFAULT gen_random_uuid()::text,
  mapping_key text,
  score_id text,
  observation_id text,
  sync_state text NOT NULL CHECK (sync_state IN ('queued', 'pending', 'completed', 'failed', 'timed_out', 'unmatched', 'stale')),
  raw_payload jsonb NOT NULL,
  reason text NOT NULL CHECK (reason <> ''),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (producer, namespace, quarantine_id),
  CHECK (mapping_key IS NULL OR mapping_key ~ '^canonical-json/v1:[0-9a-f]{64}$')
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['langfuse_mapping', 'langfuse_sync_transition', 'langfuse_inbound_quarantine'] LOOP
    EXECUTE format('ALTER TABLE observation.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE observation.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON observation.%I USING (producer = current_setting(''observation.producer'', true) AND namespace = current_setting(''observation.namespace'', true)) WITH CHECK (producer = current_setting(''observation.producer'', true) AND namespace = current_setting(''observation.namespace'', true))', table_name || '_tenant', table_name);
  END LOOP;
END $$;

-- Pins and acquired external IDs never change; only sync state and its timestamp may advance.
CREATE FUNCTION observation.guard_langfuse_mapping_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'langfuse mapping cannot be deleted'; END IF;
  IF (NEW.producer, NEW.namespace, NEW.mapping_key, NEW.occurrence_id, NEW.evidence_set_id,
      NEW.evidence_set_digest, NEW.question_id, NEW.question_version, NEW.projection_version,
      NEW.execution_id, NEW.attempt_id, NEW.created_at) IS DISTINCT FROM
     (OLD.producer, OLD.namespace, OLD.mapping_key, OLD.occurrence_id, OLD.evidence_set_id,
      OLD.evidence_set_digest, OLD.question_id, OLD.question_version, OLD.projection_version,
      OLD.execution_id, OLD.attempt_id, OLD.created_at) THEN
    RAISE EXCEPTION 'langfuse mapping identity is immutable';
  END IF;
  IF (OLD.trace_id IS NOT NULL AND NEW.trace_id IS DISTINCT FROM OLD.trace_id)
    OR (OLD.observation_id IS NOT NULL AND NEW.observation_id IS DISTINCT FROM OLD.observation_id)
    OR (OLD.score_id IS NOT NULL AND NEW.score_id IS DISTINCT FROM OLD.score_id)
    OR (OLD.queue_item_id IS NOT NULL AND NEW.queue_item_id IS DISTINCT FROM OLD.queue_item_id) THEN
    RAISE EXCEPTION 'langfuse external identifiers are immutable';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER langfuse_mapping_immutable BEFORE UPDATE OR DELETE ON observation.langfuse_mapping
  FOR EACH ROW EXECUTE FUNCTION observation.guard_langfuse_mapping_mutation();

CREATE FUNCTION observation.record_langfuse_sync_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.sync_state IS DISTINCT FROM OLD.sync_state THEN
    INSERT INTO observation.langfuse_sync_transition (producer, namespace, mapping_key, from_state, to_state)
      VALUES (NEW.producer, NEW.namespace, NEW.mapping_key,
        CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.sync_state END, NEW.sync_state);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER langfuse_mapping_transition AFTER INSERT OR UPDATE OF sync_state ON observation.langfuse_mapping
  FOR EACH ROW EXECUTE FUNCTION observation.record_langfuse_sync_transition();

CREATE FUNCTION observation.reject_langfuse_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'langfuse history is append-only';
END $$;
CREATE TRIGGER langfuse_sync_transition_append_only BEFORE UPDATE OR DELETE ON observation.langfuse_sync_transition
  FOR EACH ROW EXECUTE FUNCTION observation.reject_langfuse_history_mutation();
CREATE TRIGGER langfuse_inbound_quarantine_append_only BEFORE UPDATE OR DELETE ON observation.langfuse_inbound_quarantine
  FOR EACH ROW EXECUTE FUNCTION observation.reject_langfuse_history_mutation();
