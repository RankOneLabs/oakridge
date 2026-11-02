// Generated from src/storage/migrations. Run bun observation/scripts/generate-storage-records.ts.
import type { Generated } from "kysely";
import type { JsonValue } from "../domain/primitives";
import type { JsonColumn, NullableJsonColumn, GeneratedJsonColumn } from "./json-column-types";

export interface ObservationBlindAssignment {
  producer: string;
  namespace: string;
  assignment_id: string;
  subject_occurrence_id: string;
  evidence_set_id: string;
  question_id: string;
  question_version: string;
  claim_owner: string | null;
  claimed_at: Date | null;
  expires_at: Date | null;
  submitted_observation_id: string | null;
  created_at: Generated<Date>;
}

export interface ObservationEvaluationEligibility {
  producer: string;
  namespace: string;
  subject_occurrence_id: string;
  question_id: string;
  question_version: string;
  tag: string;
  payload: JsonColumn<JsonValue>;
  recorded_at: Generated<Date>;
  eligibility_id: Generated<string>;
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
  model_usage: NullableJsonColumn<JsonValue>;
  cost: number | null;
  external_execution_id: string | null;
  provider_link: string | null;
  reproducibility_metadata: NullableJsonColumn<JsonValue>;
  provider_attempts: GeneratedJsonColumn<JsonValue>;
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
  cost_metadata: NullableJsonColumn<JsonValue>;
  seed: number | null;
  attempt_controls: NullableJsonColumn<JsonValue>;
  identity_digest: string;
  instruction_text: string | null;
}

export interface ObservationEvidenceSet {
  producer: string;
  namespace: string;
  evidence_set_id: string;
  evidence_refs: JsonColumn<JsonValue>;
  is_incomplete: boolean;
  incompleteness_reason: string | null;
  created_at: Generated<Date>;
}

export interface ObservationExportManifest {
  producer: string;
  namespace: string;
  manifest_id: string;
  frozen_at: Date;
  membership_digest: string;
  format_version: string;
  redaction_policy: JsonColumn<JsonValue>;
  file_hashes: JsonColumn<JsonValue>;
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
  redaction_reasons: JsonColumn<JsonValue>;
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
  answer_payload: JsonColumn<JsonValue>;
  probabilities: NullableJsonColumn<JsonValue>;
  confidence: number | null;
  normalized_score: number | null;
  decision_policy_id: string | null;
  decision_policy_version: string | null;
  reviewer_id: string | null;
  reviewer_details: NullableJsonColumn<JsonValue>;
  comments: string | null;
  rationale: string | null;
  quality_flags: GeneratedJsonColumn<JsonValue>;
  supersedes_observation_id: string | null;
  recorded_at: Generated<Date>;
  collection_mode: string | null;
  blind_assignment_id: string | null;
  model_answers_visible: boolean | null;
  workflow_decisions_visible: boolean | null;
  label_origin: Generated<string | null>;
}

export interface ObservationGradingJob {
  producer: string;
  namespace: string;
  job_id: string;
  subject_occurrence_id: string;
  evidence_set_id: string;
  question_id: string;
  question_version: string;
  evaluator_definition_id: string;
  config_digest: string;
  attempt_label: string;
  idempotency_digest: string;
  reviewed_commit: string | null;
  runner_name: string;
  run_id: string;
  stage_id: string;
  state: string;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  attempts: Generated<number>;
  retry_limit: number;
  terminal_cause: string | null;
  estimated_cost: Generated<number>;
  disclosure: NullableJsonColumn<JsonValue>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ObservationIngestReceipt {
  producer: string;
  namespace: string;
  request_key: string;
  revision_id: string;
  outcome: string;
  response: JsonColumn<JsonValue>;
  stored_digest: string;
  incoming_digest: string;
  recorded_at: Generated<Date>;
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
  selected_value: JsonColumn<JsonValue>;
  logical_item_id: string | null;
  json_pointer: string | null;
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

export interface ObservationLangfuseInboundQuarantine {
  producer: string;
  namespace: string;
  quarantine_id: Generated<string>;
  mapping_key: string | null;
  score_id: string | null;
  observation_id: string | null;
  sync_state: string;
  raw_payload: JsonColumn<JsonValue>;
  reason: string;
  recorded_at: Generated<Date>;
}

export interface ObservationLangfuseMapping {
  producer: string;
  namespace: string;
  mapping_key: string;
  occurrence_id: string;
  evidence_set_id: string;
  evidence_set_digest: string;
  question_id: string;
  question_version: string;
  projection_version: string;
  execution_id: string;
  attempt_id: string;
  trace_id: string | null;
  observation_id: string | null;
  score_id: string | null;
  queue_item_id: string | null;
  sync_state: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ObservationLangfuseSyncTransition {
  producer: string;
  namespace: string;
  transition_id: Generated<string>;
  mapping_key: string;
  from_state: string | null;
  to_state: string;
  recorded_at: Generated<Date>;
}

export interface ObservationLogicalItem {
  producer: string;
  namespace: string;
  logical_item_id: string;
  run_id: string;
  scope: string;
  producer_local_id: string;
}

export interface ObservationPurgeEvent {
  producer: string;
  namespace: string;
  purge_id: string;
  run_id: string;
  trigger_event_id: string;
  trigger_run_key: string;
  operator_override: boolean;
  frozen_manifest_ids: JsonColumn<JsonValue>;
  source_revisions_removed: number;
  item_occurrences_removed: number;
  item_relations_removed: number;
  extraction_issues_removed: number;
  evaluation_executions_removed: number;
  grade_observations_removed: number;
  recorded_at: Generated<Date>;
}

export interface ObservationQuestionDefinition {
  producer: string;
  namespace: string;
  question_id: string;
  question_version: string;
  target_item_kinds: JsonColumn<JsonValue>;
  input_recipe: JsonColumn<JsonValue>;
  response_kind: string;
  allowed_values: NullableJsonColumn<JsonValue>;
  missing_evidence_policy: string;
  abstain_semantics: string;
  unclear_semantics: string;
  interpretation_caveats: string;
  requires_repository_snapshot: boolean;
  question_text: string | null;
  evidence_recipe_provenance: NullableJsonColumn<JsonValue>;
}

export interface ObservationSchemaBaseline {
  id: Generated<boolean>;
  digest: string;
  applied_at: Generated<Date>;
}

export interface ObservationSchemaMigration {
  ordinal: number;
  name: string;
  digest: string;
  applied_at: Generated<Date>;
}

export interface ObservationSourceBackfillPosition {
  producer: string;
  namespace: string;
  position: JsonColumn<JsonValue>;
  counts: JsonColumn<JsonValue>;
  updated_at: Generated<Date>;
}

export interface ObservationSourceCollaborationComment {
  producer: string;
  namespace: string;
  message_id: string;
  thread_id: string;
  run_id: string;
  unit_id: string;
  revision_id: string | null;
  anchor: string | null;
  title: string;
  body: JsonColumn<JsonValue>;
  occurrence_id: string | null;
  recorded_at: Date;
}

export interface ObservationSourceEventCursor {
  producer: string;
  namespace: string;
  commit_txid: Generated<number>;
  event_id: Generated<string>;
}

export interface ObservationSourceEventIssue {
  producer: string;
  namespace: string;
  issue_id: string;
  event_id: string;
  run_id: string;
  event_kind: string;
  target_revision_id: string | null;
  cause: string;
  original_outcome: JsonColumn<JsonValue>;
  resolution_state: Generated<string>;
  resolution_detail: string | null;
  recorded_at: Generated<Date>;
  resolved_at: Date | null;
}

export interface ObservationSourceEventOutcome {
  producer: string;
  namespace: string;
  event_id: string;
  run_id: string;
  commit_txid: number;
  event_kind: string;
  outcome_kind: string;
  detail: JsonColumn<JsonValue>;
  recorded_at: Generated<Date>;
}

export interface ObservationSourceHumanGrade {
  producer: string;
  namespace: string;
  event_id: string;
  run_id: string;
  unit_id: string;
  review: string;
  decision: string;
  target_revision_id: string;
  evaluator_kind: string;
  feedback: NullableJsonColumn<JsonValue>;
}

export interface ObservationSourceOperatorCursor {
  producer: string;
  namespace: string;
  commit_txid: Generated<number>;
  event_id: Generated<string>;
}

export interface ObservationSourceRepairPosition {
  producer: string;
  namespace: string;
  commit_txid: Generated<number>;
  event_id: Generated<string>;
  completed_through_txid: Generated<number>;
  updated_at: Generated<Date>;
}

export interface ObservationSourceRevision {
  producer: string;
  namespace: string;
  revision_id: string;
  run_id: string;
  unit_id: string;
  artifact_kind: string;
  artifact_schema_version: string;
  definition_bundle_id: string | null;
  definition_bundle_digest: string | null;
  body: JsonColumn<JsonValue>;
  body_digest: string;
  recorded_at: Date;
  captured_at: Generated<Date>;
  predecessor_id: string | null;
  subject_id: string | null;
  definition_id: string | null;
  collection_key: string | null;
}

export interface DB {
  "observation.blind_assignment": ObservationBlindAssignment;
  "observation.evaluation_eligibility": ObservationEvaluationEligibility;
  "observation.evaluation_execution": ObservationEvaluationExecution;
  "observation.evaluator_definition": ObservationEvaluatorDefinition;
  "observation.evidence_set": ObservationEvidenceSet;
  "observation.export_manifest": ObservationExportManifest;
  "observation.export_membership": ObservationExportMembership;
  "observation.extraction_issue": ObservationExtractionIssue;
  "observation.extractor_definition": ObservationExtractorDefinition;
  "observation.grade_observation": ObservationGradeObservation;
  "observation.grading_job": ObservationGradingJob;
  "observation.ingest_receipt": ObservationIngestReceipt;
  "observation.item_occurrence": ObservationItemOccurrence;
  "observation.item_relation": ObservationItemRelation;
  "observation.langfuse_inbound_quarantine": ObservationLangfuseInboundQuarantine;
  "observation.langfuse_mapping": ObservationLangfuseMapping;
  "observation.langfuse_sync_transition": ObservationLangfuseSyncTransition;
  "observation.logical_item": ObservationLogicalItem;
  "observation.purge_event": ObservationPurgeEvent;
  "observation.question_definition": ObservationQuestionDefinition;
  "observation.schema_baseline": ObservationSchemaBaseline;
  "observation.schema_migration": ObservationSchemaMigration;
  "observation.source_backfill_position": ObservationSourceBackfillPosition;
  "observation.source_collaboration_comment": ObservationSourceCollaborationComment;
  "observation.source_event_cursor": ObservationSourceEventCursor;
  "observation.source_event_issue": ObservationSourceEventIssue;
  "observation.source_event_outcome": ObservationSourceEventOutcome;
  "observation.source_human_grade": ObservationSourceHumanGrade;
  "observation.source_operator_cursor": ObservationSourceOperatorCursor;
  "observation.source_repair_position": ObservationSourceRepairPosition;
  "observation.source_revision": ObservationSourceRevision;
}
