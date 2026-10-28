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
