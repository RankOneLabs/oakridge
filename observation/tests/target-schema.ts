/**
 * The target storage inventory, written by hand from the named model in
 * observation/src/grading and the capture contracts. It is the independent expectation that
 * target-schema.test.ts compares the applied baseline against; never generate it from the SQL.
 *
 * A column is `name type [null] [default]`; a constraint is its column list.
 */
export type ColumnSpec = string;
export interface TableSpec {
  readonly columns: readonly ColumnSpec[];
  readonly primary_key: string;
  readonly unique: readonly string[];
  /** `local columns -> table(foreign columns)` */
  readonly foreign_keys: readonly string[];
  /** Every CHECK predicate, in source SQL form; PostgreSQL normalizes both sides for comparison. */
  readonly checks: readonly string[];
}

const TENANT = ["producer text", "namespace text"];
const CANONICAL_DIGEST = "'^canonical-json/v1:[0-9a-f]{64}$'";
const RESPONSE_KINDS = "('boolean', 'choice', 'ordinal', 'numeric', 'text', 'structured')";
export const TARGET_TABLES: Readonly<Record<string, TableSpec>> = {
  schema_baseline: {
    columns: ["id boolean default", "digest text", "applied_at timestamptz default"],
    primary_key: "id", unique: [], foreign_keys: [],
    checks: [
      "id",
      "digest ~ '^[0-9a-f]{64}$'",
    ],
  },
  source_revision: {
    columns: [...TENANT, "revision_id text", "run_id text", "unit_id text", "artifact_kind text", "artifact_schema_version text",
      "definition_id text", "body jsonb", "body_digest text", "recorded_at timestamptz", "captured_at timestamptz default",
      "predecessor_id text null", "subject_id text null"],
    primary_key: "producer,namespace,revision_id", unique: [], foreign_keys: [],
    checks: [
      `body_digest ~ ${CANONICAL_DIGEST}`,
      "producer <> '' AND namespace <> '' AND revision_id <> ''",
      "predecessor_id IS NULL OR predecessor_id <> ''",
      "subject_id IS NULL OR subject_id <> ''",
    ],
  },
  extractor_definition: {
    columns: [...TENANT, "artifact_kind text", "schema_version text", "extractor_id text", "extractor_version text",
      "item_kind text", "item_selector text"],
    primary_key: "producer,namespace,artifact_kind,schema_version,extractor_id,extractor_version", unique: [], foreign_keys: [],
    checks: [
      "producer <> '' AND namespace <> '' AND extractor_id <> '' AND extractor_version <> ''",
    ],
  },
  logical_item: {
    columns: [...TENANT, "logical_item_id text", "run_id text", "scope text", "producer_local_id text"],
    primary_key: "producer,namespace,logical_item_id", unique: [], foreign_keys: [],
    checks: [
      "logical_item_id = producer || ':' || namespace || ':' || run_id || ':' || scope || ':' || producer_local_id",
    ],
  },
  item_occurrence: {
    columns: [...TENANT, "occurrence_id text", "revision_id text", "run_id text", "artifact_kind text", "schema_version text",
      "extractor_id text", "extractor_version text", "item_kind text", "item_selector text", "item_id_or_path text",
      "item_scope text null", "producer_local_id text null", "selected_value jsonb", "logical_item_id text null", "json_pointer text"],
    primary_key: "occurrence_id",
    unique: ["producer,namespace,occurrence_id", "producer,namespace,occurrence_id,run_id", "producer,namespace,revision_id,json_pointer",
      "producer,namespace,revision_id,extractor_id,extractor_version,item_selector,item_id_or_path"],
    foreign_keys: ["producer,namespace,revision_id -> source_revision(producer,namespace,revision_id)",
      "producer,namespace,artifact_kind,schema_version,extractor_id,extractor_version -> extractor_definition(producer,namespace,artifact_kind,schema_version,extractor_id,extractor_version)",
      "producer,namespace,logical_item_id -> logical_item(producer,namespace,logical_item_id)"],
    checks: [
      `occurrence_id ~ ${CANONICAL_DIGEST}`,
      "json_pointer <> ''",
    ],
  },
  item_relation: {
    columns: [...TENANT, "relation_id text", "source_occurrence_id text null", "source_logical_item_id text null",
      "target_occurrence_id text null", "target_logical_item_id text null", "unresolved_target_ref text null", "type text",
      "asserted_by text", "evidence_ref text", "algorithm text null", "algorithm_version text null", "recorded_at timestamptz default"],
    primary_key: "producer,namespace,relation_id", unique: [],
    foreign_keys: ["producer,namespace,source_occurrence_id -> item_occurrence(producer,namespace,occurrence_id)",
      "producer,namespace,source_logical_item_id -> logical_item(producer,namespace,logical_item_id)",
      "producer,namespace,target_occurrence_id -> item_occurrence(producer,namespace,occurrence_id)",
      "producer,namespace,target_logical_item_id -> logical_item(producer,namespace,logical_item_id)"],
    checks: [
      "type IN ('derived_from', 'addresses', 'assesses', 'supersedes', 'split_from', 'merged_from')",
      "asserted_by IN ('producer_explicit', 'human', 'inferred')",
      "num_nonnulls(source_occurrence_id, source_logical_item_id) = 1",
      "num_nonnulls(target_occurrence_id, target_logical_item_id, unresolved_target_ref) = 1",
      "(asserted_by = 'inferred') = (algorithm IS NOT NULL AND algorithm_version IS NOT NULL)",
      "type <> 'split_from' OR asserted_by = 'human'",
    ],
  },
  extraction_issue: {
    columns: [...TENANT, "issue_id text", "revision_id text", "extractor_id text", "extractor_version text", "item_selector text",
      "kind text", "detail text", "is_retriable boolean", "recorded_at timestamptz default"],
    primary_key: "producer,namespace,issue_id", unique: [],
    foreign_keys: ["producer,namespace,revision_id -> source_revision(producer,namespace,revision_id)"],
    checks: [
      "kind IN ('extraction_failed', 'no_matching_items', 'identity_collision', 'unresolved_relation')",
    ],
  },
  question_definition: {
    columns: [...TENANT, "question_id text", "question_version text", "item_kind text", "response_kind text", "allowed_values jsonb null",
      "missing_evidence_policy text", "abstain_semantics text", "unclear_semantics text", "interpretation_caveats text", "question_text text null"],
    primary_key: "producer,namespace,question_id,question_version", unique: [], foreign_keys: [],
    checks: [
      `response_kind IN ${RESPONSE_KINDS}`,
      "missing_evidence_policy IN ('fail', 'abstain')",
      "question_id <> '' AND question_version <> '' AND item_kind <> ''",
      "allowed_values IS NULL OR jsonb_typeof(allowed_values) = 'array'",
      "response_kind NOT IN ('choice', 'ordinal') OR (allowed_values IS NOT NULL AND jsonb_array_length(allowed_values) > 0)",
    ],
  },
  evaluator_definition: {
    columns: [...TENANT, "evaluator_definition_id text", "kind text", "backend_kind text", "provider text", "model text null",
      "prompt_digest text", "config_digest text", "runtime_revision text", "cost_metadata jsonb null", "seed integer null",
      "attempt_controls jsonb null", "identity_digest text", "instruction_text text null"],
    primary_key: "producer,namespace,evaluator_definition_id", unique: ["producer,namespace,identity_digest"], foreign_keys: [],
    checks: [
      "kind IN ('model', 'code', 'human')",
      "evaluator_definition_id <> '' AND backend_kind <> '' AND provider <> '' AND runtime_revision <> ''",
      `identity_digest ~ ${CANONICAL_DIGEST}`,
    ],
  },
  evidence_set: {
    columns: [...TENANT, "evidence_set_id text", "subject_occurrence_id text", "task_id text null", "question_id text", "question_version text",
      "pinned_evaluator_definition_ids text[]", "readiness text", "not_ready_code text null", "not_ready_detail text null",
      "evidence_refs jsonb default", "is_incomplete boolean default", "incompleteness_reason text null",
      "created_at timestamptz default", "ready_at timestamptz null"],
    primary_key: "producer,namespace,evidence_set_id",
    unique: ["producer,namespace,subject_occurrence_id,task_id,question_id,question_version",
      "producer,namespace,evidence_set_id,subject_occurrence_id,task_id,question_id,question_version",
      "producer,namespace,evidence_set_id,subject_occurrence_id,question_id,question_version"],
    foreign_keys: ["producer,namespace,task_id -> logical_item(producer,namespace,logical_item_id)",
      "producer,namespace,subject_occurrence_id -> item_occurrence(producer,namespace,occurrence_id)",
      "producer,namespace,question_id,question_version -> question_definition(producer,namespace,question_id,question_version)"],
    checks: [
      "readiness IN ('not_ready', 'ready')",
      `evidence_set_id ~ ${CANONICAL_DIGEST}`,
      "cardinality(pinned_evaluator_definition_ids) > 0",
      "jsonb_typeof(evidence_refs) = 'array'",
      "(readiness = 'ready') = (ready_at IS NOT NULL)",
      "(readiness = 'not_ready') = (not_ready_code IS NOT NULL AND not_ready_detail IS NOT NULL)",
      "readiness = 'not_ready' OR (not_ready_code IS NULL AND not_ready_detail IS NULL)",
      "readiness = 'ready' OR evidence_refs = '[]'::jsonb",
      "not_ready_code IS NULL OR (not_ready_code <> '' AND not_ready_detail <> '')",
      "is_incomplete = (incompleteness_reason IS NOT NULL)",
      "incompleteness_reason IS NULL OR incompleteness_reason <> ''",
    ],
  },
  evaluation_execution: {
    columns: [...TENANT, "execution_id text", "run_id text", "subject_occurrence_id text", "task_id text null", "evidence_set_id text", "question_id text",
      "question_version text", "evaluator_definition_id text", "attempt_label text", "idempotency_digest text", "status text",
      "lease_owner text null", "lease_expires_at timestamptz null", "attempts integer default", "retries integer default",
      "retry_limit integer default", "estimated_cost double precision default", "terminal_cause text null",
      "created_at timestamptz default", "updated_at timestamptz default", "started_at timestamptz null", "ended_at timestamptz null",
      "error text null", "model_usage jsonb null", "cost double precision null", "external_execution_id text null",
      "provider_link text null", "reproducibility_metadata jsonb null"],
    primary_key: "producer,namespace,execution_id",
    unique: ["producer,namespace,idempotency_digest", "producer,namespace,execution_id,run_id"],
    foreign_keys: ["producer,namespace,task_id -> logical_item(producer,namespace,logical_item_id)",
      "producer,namespace,subject_occurrence_id,run_id -> item_occurrence(producer,namespace,occurrence_id,run_id)",
      "producer,namespace,evidence_set_id,subject_occurrence_id,task_id,question_id,question_version -> evidence_set(producer,namespace,evidence_set_id,subject_occurrence_id,task_id,question_id,question_version)",
      "producer,namespace,evidence_set_id,subject_occurrence_id,question_id,question_version -> evidence_set(producer,namespace,evidence_set_id,subject_occurrence_id,question_id,question_version)",
      "producer,namespace,question_id,question_version -> question_definition(producer,namespace,question_id,question_version)",
      "producer,namespace,evaluator_definition_id -> evaluator_definition(producer,namespace,evaluator_definition_id)"],
    checks: [
      "status IN ('queued', 'claimed', 'reclaimable', 'budget_deferred', 'completed', 'failed')",
      "terminal_cause IS NULL OR terminal_cause IN ('retry_exhausted', 'runner_failed', 'invalid_outcome')",
      `attempt_label <> '' AND idempotency_digest ~ ${CANONICAL_DIGEST}`,
      "attempts >= 0 AND retries >= 0 AND retry_limit >= 0 AND estimated_cost >= 0",
      "(status = 'claimed') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)",
      "status = 'claimed' OR (lease_owner IS NULL AND lease_expires_at IS NULL)",
      "(status = 'failed') = (error IS NOT NULL)",
      "(status IN ('completed', 'failed')) = (ended_at IS NOT NULL)",
      "terminal_cause IS NULL OR status = 'failed'",
    ],
  },
  grading_provider_attempt: {
    columns: [...TENANT, "execution_id text", "attempt integer", "run_id text", "request_sent boolean default", "outcome text null",
      "charged_cost double precision default", "admitted_estimate double precision", "cost_overage double precision default",
      "provider_request_id text null", "failure_category text null", "created_at timestamptz default", "updated_at timestamptz default"],
    primary_key: "producer,namespace,execution_id,attempt", unique: [],
    foreign_keys: ["producer,namespace,execution_id,run_id -> evaluation_execution(producer,namespace,execution_id,run_id)"],
    checks: [
      "attempt > 0",
      "outcome IS NULL OR outcome IN ('completed', 'failed')",
      "charged_cost >= 0",
      "admitted_estimate >= 0",
      "cost_overage >= 0",
      "request_sent OR charged_cost = 0",
    ],
  },
  grade_observation: {
    columns: [...TENANT, "observation_id text", "execution_id text", "answer_kind text", "answer_state text", "answer_payload jsonb",
      "probabilities jsonb null", "confidence double precision null", "reviewer_id text null", "reviewer_details jsonb null",
      "comments text null", "rationale text null", "quality_flags jsonb default", "supersedes_observation_id text null",
      "recorded_at timestamptz default"],
    primary_key: "producer,namespace,observation_id",
    unique: ["producer,namespace,execution_id", "producer,namespace,supersedes_observation_id"],
    foreign_keys: ["producer,namespace,execution_id -> evaluation_execution(producer,namespace,execution_id)",
      "producer,namespace,supersedes_observation_id -> grade_observation(producer,namespace,observation_id)"],
    checks: [
      `answer_kind IN ${RESPONSE_KINDS}`,
      "answer_state IN ('answered', 'abstain', 'unclear')",
      "jsonb_typeof(answer_payload) = 'object' AND jsonb_typeof(quality_flags) = 'array'",
      "answer_payload->>'kind' = answer_kind AND answer_payload->>'state' = answer_state",
      "(answer_state = 'answered' AND answer_payload ? 'value') OR (answer_state IN ('abstain', 'unclear') AND answer_payload ? 'reason' AND NOT (answer_payload ? 'value'))",
      "probabilities IS NULL OR jsonb_typeof(probabilities) = 'object'",
      "confidence IS NULL OR (confidence >= 0 AND confidence <= 1)",
      "reviewer_id IS NULL OR reviewer_id <> ''",
      "supersedes_observation_id IS NULL OR supersedes_observation_id <> observation_id",
    ],
  },
  source_event_cursor: {
    columns: [...TENANT, "commit_txid bigint default", "event_id text default"],
    primary_key: "producer,namespace", unique: [], foreign_keys: [],
    checks: [],
  },
  source_event_outcome: {
    columns: [...TENANT, "event_id text", "run_id text", "commit_txid bigint", "event_kind text", "outcome_kind text",
      "detail jsonb", "recorded_at timestamptz default"],
    primary_key: "producer,namespace,event_id", unique: [], foreign_keys: [],
    checks: [],
  },
};

export const DISCARDED_TABLES = ["grading_job", "evaluation_eligibility", "source_human_grade", "source_operator_cursor",
  "source_backfill_position", "source_collaboration_comment", "blind_assignment", "export_manifest", "export_membership",
  "purge_event", "ingest_receipt"] as const;

export const TARGET_TRIGGERS: Readonly<Record<string, readonly string[]>> = {
  source_revision: ["source_revision_append_only"],
  item_occurrence: ["item_occurrence_append_only"],
  question_definition: ["question_definition_append_only"],
  evaluator_definition: ["evaluator_definition_append_only"],
  evidence_set: ["evidence_set_guard", "evidence_set_valid_pin"],
  evaluation_execution: ["evaluation_execution_guard", "evaluation_execution_pinned"],
  grade_observation: ["grade_observation_append_only", "grade_observation_completed_execution", "grade_observation_correction"],
};
export const TARGET_FUNCTIONS = ["guard_evaluation_execution", "guard_evidence_set", "reject_mutation", "require_completed_execution",
  "require_correction_measurement", "require_pinned_execution", "require_valid_pin"] as const;
export const TARGET_SECONDARY_INDEXES = ["evaluation_execution_claim", "evaluation_execution_run", "evaluation_execution_subject",
  "evidence_set_not_ready", "extraction_issue_revision", "grading_provider_attempt_spend", "item_occurrence_logical",
  "item_occurrence_run_page", "item_relation_source_logical", "item_relation_source_occurrence", "item_relation_target_logical",
  "item_relation_target_occurrence", "item_relation_unresolved", "source_event_outcome_run"] as const;
