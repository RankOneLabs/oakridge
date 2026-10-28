// Generated from src/storage/migrations. Run bun observation/scripts/generate-storage-records.ts.
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
  predecessor_id: string | null;
  subject_id: string | null;
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

export interface ObservationExtractorDefinition {
  producer: string;
  namespace: string;
  artifact_kind: string;
  schema_version: string;
  extractor_id: string;
  extractor_version: string;
  item_kind: string;
  item_selector: string;
}

export interface ObservationLogicalItem {
  producer: string;
  namespace: string;
  logical_item_id: string;
  run_id: string;
  scope: string;
  producer_local_id: string;
}

export interface ObservationItemOccurrence {
  producer: string;
  namespace: string;
  occurrence_id: string;
  revision_id: string;
  run_id: string;
  artifact_kind: string;
  schema_version: string;
  extractor_id: string;
  extractor_version: string;
  item_kind: string;
  item_selector: string;
  item_id_or_path: string;
  item_scope: string | null;
  producer_local_id: string | null;
  selected_value: JsonValue;
  logical_item_id: string | null;
}

export interface ObservationItemRelation {
  producer: string;
  namespace: string;
  relation_id: string;
  source_occurrence_id: string | null;
  source_logical_item_id: string | null;
  target_occurrence_id: string | null;
  target_logical_item_id: string | null;
  unresolved_target_ref: string | null;
  type: string;
  asserted_by: string;
  evidence_ref: string;
  algorithm: string | null;
  algorithm_version: string | null;
  recorded_at: Generated<Date>;
}

export interface ObservationExtractionIssue {
  producer: string;
  namespace: string;
  issue_id: string;
  revision_id: string;
  extractor_id: string;
  extractor_version: string;
  item_selector: string;
  kind: string;
  detail: string;
  is_retriable: boolean;
  recorded_at: Generated<Date>;
}

export interface DB {
  "observation.schema_baseline": ObservationSchemaBaseline;
  "observation.source_revision": ObservationSourceRevision;
  "observation.ingest_receipt": ObservationIngestReceipt;
  "observation.extractor_definition": ObservationExtractorDefinition;
  "observation.logical_item": ObservationLogicalItem;
  "observation.item_occurrence": ObservationItemOccurrence;
  "observation.item_relation": ObservationItemRelation;
  "observation.extraction_issue": ObservationExtractionIssue;
}
