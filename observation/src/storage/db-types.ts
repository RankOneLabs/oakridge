// Generated from src/storage/migrations/0001_observation.sql. Run bun observation/scripts/generate-storage-records.ts.
import type { Generated } from "kysely";
import type { JsonValue } from "../domain/primitives";

export interface ObservationSchemaBaseline {
  id: Generated<boolean>;
  digest: string;
  applied_at: Generated<Date>;
}

export interface ObservationSourceRevision {
  producer: string;
  namespace: string;
  revision_id: string;
  run_id: string;
  unit_id: string;
  artifact_kind: string;
  artifact_schema_version: string;
  definition_bundle_id: string;
  definition_bundle_digest: string;
  body: JsonValue;
  body_digest: string;
  recorded_at: Date;
  captured_at: Generated<Date>;
}

export interface ObservationIngestReceipt {
  producer: string;
  namespace: string;
  request_key: string;
  revision_id: string;
  outcome: string;
  response: JsonValue;
  stored_digest: string;
  incoming_digest: string;
  recorded_at: Generated<Date>;
}

export interface DB {
  "observation.schema_baseline": ObservationSchemaBaseline;
  "observation.source_revision": ObservationSourceRevision;
  "observation.ingest_receipt": ObservationIngestReceipt;
}
