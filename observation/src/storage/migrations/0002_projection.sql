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
