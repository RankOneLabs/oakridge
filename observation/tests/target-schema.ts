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
}

const TENANT = ["producer text", "namespace text"];
export const TARGET_TABLES: Readonly<Record<string, TableSpec>> = {
  schema_baseline: {
    columns: ["id boolean default", "digest text", "applied_at timestamptz default"],
    primary_key: "id", unique: [], foreign_keys: [],
  },
  source_revision: {
    columns: [...TENANT, "revision_id text", "run_id text", "unit_id text", "artifact_kind text", "artifact_schema_version text",
      "definition_id text", "body jsonb", "body_digest text", "recorded_at timestamptz", "captured_at timestamptz default",
      "predecessor_id text null", "subject_id text null"],
    primary_key: "producer,namespace,revision_id", unique: [], foreign_keys: [],
  },
  extractor_definition: {
    columns: [...TENANT, "artifact_kind text", "schema_version text", "extractor_id text", "extractor_version text",
      "item_kind text", "item_selector text"],
    primary_key: "producer,namespace,artifact_kind,schema_version,extractor_id,extractor_version", unique: [], foreign_keys: [],
  },
  logical_item: {
    columns: [...TENANT, "logical_item_id text", "run_id text", "scope text", "producer_local_id text"],
    primary_key: "producer,namespace,logical_item_id", unique: [], foreign_keys: [],
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
  },
  extraction_issue: {
    columns: [...TENANT, "issue_id text", "revision_id text", "extractor_id text", "extractor_version text", "item_selector text",
      "kind text", "detail text", "is_retriable boolean", "recorded_at timestamptz default"],
    primary_key: "producer,namespace,issue_id", unique: [],
    foreign_keys: ["producer,namespace,revision_id -> source_revision(producer,namespace,revision_id)"],
  },
  question_definition: {
    columns: [...TENANT, "question_id text", "question_version text", "item_kind text", "response_kind text", "allowed_values jsonb null",
      "missing_evidence_policy text", "abstain_semantics text", "unclear_semantics text", "interpretation_caveats text", "question_text text null"],
    primary_key: "producer,namespace,question_id,question_version", unique: [], foreign_keys: [],
  },
  evaluator_definition: {
    columns: [...TENANT, "evaluator_definition_id text", "kind text", "backend_kind text", "provider text", "model text null",
      "prompt_digest text", "config_digest text", "runtime_revision text", "cost_metadata jsonb null", "seed integer null",
      "attempt_controls jsonb null", "identity_digest text", "instruction_text text null"],
    primary_key: "producer,namespace,evaluator_definition_id", unique: ["producer,namespace,identity_digest"], foreign_keys: [],
  },
  evidence_set: {
    columns: [...TENANT, "evidence_set_id text", "subject_occurrence_id text", "question_id text", "question_version text",
      "pinned_evaluator_definition_ids text[]", "readiness text", "not_ready_code text null", "not_ready_detail text null",
      "evidence_refs jsonb default", "is_incomplete boolean default", "incompleteness_reason text null",
      "created_at timestamptz default", "ready_at timestamptz null"],
    primary_key: "producer,namespace,evidence_set_id",
    unique: ["producer,namespace,subject_occurrence_id,question_id,question_version",
      "producer,namespace,evidence_set_id,subject_occurrence_id,question_id,question_version"],
    foreign_keys: ["producer,namespace,subject_occurrence_id -> item_occurrence(producer,namespace,occurrence_id)",
      "producer,namespace,question_id,question_version -> question_definition(producer,namespace,question_id,question_version)"],
  },
  evaluation_execution: {
    columns: [...TENANT, "execution_id text", "run_id text", "subject_occurrence_id text", "evidence_set_id text", "question_id text",
      "question_version text", "evaluator_definition_id text", "attempt_label text", "idempotency_digest text", "status text",
      "lease_owner text null", "lease_expires_at timestamptz null", "attempts integer default", "retries integer default",
      "retry_limit integer default", "estimated_cost double precision default", "terminal_cause text null",
      "created_at timestamptz default", "updated_at timestamptz default", "started_at timestamptz null", "ended_at timestamptz null",
      "error text null", "model_usage jsonb null", "cost double precision null", "external_execution_id text null",
      "provider_link text null", "reproducibility_metadata jsonb null"],
    primary_key: "producer,namespace,execution_id",
    unique: ["producer,namespace,idempotency_digest", "producer,namespace,execution_id,run_id"],
    foreign_keys: ["producer,namespace,subject_occurrence_id,run_id -> item_occurrence(producer,namespace,occurrence_id,run_id)",
      "producer,namespace,evidence_set_id,subject_occurrence_id,question_id,question_version -> evidence_set(producer,namespace,evidence_set_id,subject_occurrence_id,question_id,question_version)",
      "producer,namespace,question_id,question_version -> question_definition(producer,namespace,question_id,question_version)",
      "producer,namespace,evaluator_definition_id -> evaluator_definition(producer,namespace,evaluator_definition_id)"],
  },
  grading_provider_attempt: {
    columns: [...TENANT, "execution_id text", "attempt integer", "run_id text", "request_sent boolean default", "outcome text null",
      "charged_cost double precision default", "admitted_estimate double precision", "cost_overage double precision default",
      "provider_request_id text null", "failure_category text null", "created_at timestamptz default", "updated_at timestamptz default"],
    primary_key: "producer,namespace,execution_id,attempt", unique: [],
    foreign_keys: ["producer,namespace,execution_id,run_id -> evaluation_execution(producer,namespace,execution_id,run_id)"],
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
  },
  source_event_cursor: {
    columns: [...TENANT, "commit_txid bigint default", "event_id text default"],
    primary_key: "producer,namespace", unique: [], foreign_keys: [],
  },
  source_event_outcome: {
    columns: [...TENANT, "event_id text", "run_id text", "commit_txid bigint", "event_kind text", "outcome_kind text",
      "detail jsonb", "recorded_at timestamptz default"],
    primary_key: "producer,namespace,event_id", unique: [], foreign_keys: [],
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
/** CHECK constraints per table; their behavior is exercised in grading-integrity and capture-pins. */
export const TARGET_CHECK_COUNTS: Readonly<Record<string, number>> = {
  schema_baseline: 2, source_revision: 4, extractor_definition: 1, logical_item: 1, item_occurrence: 2, item_relation: 6,
  extraction_issue: 1, question_definition: 5, evaluator_definition: 3, evidence_set: 11, evaluation_execution: 9,
  grading_provider_attempt: 6, grade_observation: 9, source_event_cursor: 0, source_event_outcome: 0,
};
