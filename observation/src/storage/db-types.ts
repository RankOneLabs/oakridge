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
  stage: string;
  artifact_kind: string;
  artifact_schema_version: string;
  definition_id: string;
  body: JsonValue;
  body_digest: string;
  recorded_at: Date;
  captured_at: Generated<Date>;
  predecessor_id: string | null;
  subject_id: string | null;
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
  json_pointer: string;
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
  item_kind: string;
  response_kind: string;
  allowed_values: JsonValue | null;
  missing_evidence_policy: string;
  abstain_semantics: string;
  unclear_semantics: string;
  interpretation_caveats: string;
  question_text: string | null;
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
  instruction_text: string | null;
}

export interface ObservationEvidenceSet {
  producer: string;
  namespace: string;
  evidence_set_id: string;
  subject_occurrence_id: string;
  task_id: string | null;
  question_id: string;
  question_version: string;
  pinned_evaluator_definition_ids: string[];
  readiness: string;
  not_ready_code: string | null;
  not_ready_detail: string | null;
  evidence_refs: Generated<JsonValue>;
  is_incomplete: Generated<boolean>;
  incompleteness_reason: string | null;
  created_at: Generated<Date>;
  ready_at: Date | null;
}

export interface ObservationEvaluationExecution {
  producer: string;
  namespace: string;
  execution_id: string;
  run_id: string;
  subject_occurrence_id: string;
  task_id: string | null;
  evidence_set_id: string;
  question_id: string;
  question_version: string;
  evaluator_definition_id: string;
  attempt_label: string;
  idempotency_digest: string;
  status: string;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  attempts: Generated<number>;
  retries: Generated<number>;
  retry_limit: Generated<number>;
  estimated_cost: Generated<number>;
  terminal_cause: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  started_at: Date | null;
  ended_at: Date | null;
  error: string | null;
  model_usage: JsonValue | null;
  cost: number | null;
  external_execution_id: string | null;
  provider_link: string | null;
  reproducibility_metadata: JsonValue | null;
}

export interface ObservationGradingProviderAttempt {
  producer: string;
  namespace: string;
  execution_id: string;
  attempt: number;
  run_id: string;
  request_sent: Generated<boolean>;
  outcome: string | null;
  charged_cost: Generated<number>;
  admitted_estimate: number;
  cost_overage: Generated<number>;
  provider_request_id: string | null;
  failure_category: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ObservationGradeObservation {
  producer: string;
  namespace: string;
  observation_id: string;
  execution_id: string;
  answer_kind: string;
  answer_state: string;
  answer_payload: JsonValue;
  probabilities: JsonValue | null;
  confidence: number | null;
  reviewer_id: string | null;
  reviewer_details: JsonValue | null;
  comments: string | null;
  rationale: string | null;
  quality_flags: Generated<JsonValue>;
  supersedes_observation_id: string | null;
  recorded_at: Generated<Date>;
}

export interface ObservationSourceEventCursor {
  producer: string;
  namespace: string;
  commit_txid: Generated<number>;
  event_id: Generated<string>;
}

export interface ObservationSourceEventOutcome {
  producer: string;
  namespace: string;
  event_id: string;
  run_id: string;
  commit_txid: number;
  event_kind: string;
  outcome_kind: string;
  detail: JsonValue;
  recorded_at: Generated<Date>;
}

export interface DB {
  "observation.schema_baseline": ObservationSchemaBaseline;
  "observation.source_revision": ObservationSourceRevision;
  "observation.extractor_definition": ObservationExtractorDefinition;
  "observation.logical_item": ObservationLogicalItem;
  "observation.item_occurrence": ObservationItemOccurrence;
  "observation.item_relation": ObservationItemRelation;
  "observation.extraction_issue": ObservationExtractionIssue;
  "observation.question_definition": ObservationQuestionDefinition;
  "observation.evaluator_definition": ObservationEvaluatorDefinition;
  "observation.evidence_set": ObservationEvidenceSet;
  "observation.evaluation_execution": ObservationEvaluationExecution;
  "observation.grading_provider_attempt": ObservationGradingProviderAttempt;
  "observation.grade_observation": ObservationGradeObservation;
  "observation.source_event_cursor": ObservationSourceEventCursor;
  "observation.source_event_outcome": ObservationSourceEventOutcome;
}
