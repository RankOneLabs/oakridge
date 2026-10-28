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

export interface ObservationQuestionDefinition {
  producer: string;
  namespace: string;
  question_id: string;
  question_version: string;
  target_item_kinds: JsonValue;
  input_recipe: JsonValue;
  response_kind: string;
  allowed_values: JsonValue | null;
  missing_evidence_policy: string;
  abstain_semantics: string;
  unclear_semantics: string;
  interpretation_caveats: string;
  requires_repository_snapshot: boolean;
}

export interface ObservationEvidenceSet {
  producer: string;
  namespace: string;
  evidence_set_id: string;
  evidence_refs: JsonValue;
  is_incomplete: boolean;
  incompleteness_reason: string | null;
  created_at: Generated<Date>;
}

export interface ObservationEvaluatorDefinition {
  producer: string;
  namespace: string;
  evaluator_definition_id: string;
  kind: string;
  backend_kind: string;
  provider: string;
  model: string | null;
  prompt_digest: string;
  config_digest: string;
  runtime_revision: string;
  cost_metadata: JsonValue | null;
  seed: number | null;
  attempt_controls: JsonValue | null;
  identity_digest: string;
}

export interface ObservationEvaluationExecution {
  producer: string;
  namespace: string;
  execution_id: string;
  subject_occurrence_id: string;
  evidence_set_id: string;
  question_id: string;
  question_version: string;
  evaluator_definition_id: string;
  config_digest: string;
  attempt_label: string;
  idempotency_digest: string;
  attempts: Generated<number>;
  retries: Generated<number>;
  started_at: Generated<Date>;
  ended_at: Date | null;
  status: string;
  error: string | null;
  model_usage: JsonValue | null;
  cost: number | null;
  external_execution_id: string | null;
  provider_link: string | null;
  reproducibility_metadata: JsonValue | null;
}

export interface ObservationGradeObservation {
  producer: string;
  namespace: string;
  observation_id: string;
  execution_id: string;
  subject_occurrence_id: string;
  evidence_set_id: string;
  question_id: string;
  question_version: string;
  evaluator_definition_id: string;
  answer_kind: string;
  answer_state: string;
  answer_payload: JsonValue;
  probabilities: JsonValue | null;
  confidence: number | null;
  normalized_score: number | null;
  decision_policy_id: string | null;
  decision_policy_version: string | null;
  reviewer_id: string | null;
  reviewer_details: JsonValue | null;
  comments: string | null;
  rationale: string | null;
  quality_flags: Generated<JsonValue>;
  supersedes_observation_id: string | null;
  recorded_at: Generated<Date>;
}

export interface ObservationExportManifest {
  producer: string;
  namespace: string;
  manifest_id: string;
  frozen_at: Date;
  membership_digest: string;
  format_version: string;
  redaction_policy: JsonValue;
  file_hashes: JsonValue;
}

export interface ObservationExportMembership {
  producer: string;
  namespace: string;
  manifest_id: string;
  candidate_id: string;
  occurrence_id: string;
  revision_id: string;
  revision_digest: string;
  evidence_set_id: string | null;
  evidence_set_digest: string | null;
  observation_id: string | null;
  disposition: string;
  reason: string;
  redaction_reasons: JsonValue;
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
  "observation.question_definition": ObservationQuestionDefinition;
  "observation.evidence_set": ObservationEvidenceSet;
  "observation.evaluator_definition": ObservationEvaluatorDefinition;
  "observation.evaluation_execution": ObservationEvaluationExecution;
  "observation.grade_observation": ObservationGradeObservation;
  "observation.export_manifest": ObservationExportManifest;
  "observation.export_membership": ObservationExportMembership;
}
