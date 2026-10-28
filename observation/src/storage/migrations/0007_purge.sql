-- Frozen manifests retain their identity snapshots after an explicitly overridden purge.
-- Membership is immutable; its IDs remain auditable even when source rows are removed.
ALTER TABLE observation.item_occurrence ADD COLUMN json_pointer text;
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
