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
