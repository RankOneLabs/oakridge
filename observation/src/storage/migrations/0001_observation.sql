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
  definition_bundle_id text NOT NULL,
  definition_bundle_digest text NOT NULL,
  body jsonb NOT NULL,
  body_digest text NOT NULL CHECK (body_digest ~ '^canonical-json/v1:[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
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
