import type { ArtifactId, JsonValue, RunUnitId, StageInstanceId, UnitId, WorkflowRunId, WorkOrderId } from "./primitives";
import type { EpicWorkflowProfile } from "./epic";
import type { RunOutputSlotState, WorkOrderState } from "./run-record";

export type OperatorRunStatus = "pending" | "running" | "parked" | "failed" | "complete" | "cancelled";
export type OperatorStageStatus = "pending" | "running" | "complete" | "failed" | "parked";
export interface OperatorRunSummary { readonly id: WorkflowRunId; readonly workflow_name: string; readonly current_attempt_root_workflow_id: string; readonly status: OperatorRunStatus; readonly current_stage: string | null; readonly parked_count: number; readonly updated_at: string; readonly is_stuck: boolean; readonly is_failed: boolean; readonly archived: boolean }
export interface OperatorWorkflowAttempt { readonly root_workflow_id: string; readonly forked_from_root_workflow_id: string | null; readonly status: OperatorRunStatus; readonly created_at: string }
export interface OperatorStageArtifact { readonly id: ArtifactId; readonly type_id: string; readonly version: number; readonly label: string | null }
export interface OperatorStageUnit { readonly unit_id: UnitId; readonly repository_key: string | null; readonly params: JsonValue | null; readonly sid: string | null; readonly worktree: { readonly branch: string; readonly path: string; readonly base_ref: string } | null; readonly base_sha: string | null; readonly status: OperatorStageStatus; readonly gate: string | null; readonly admission_required: boolean; readonly admitted: boolean; readonly admission_eligible: boolean; readonly admission_blocked_by: readonly string[] }
export interface OperatorStageDetail { readonly stage_instance_id: StageInstanceId; readonly name: string; readonly type: string; readonly operator_role: string | null; readonly status: OperatorStageStatus; readonly artifacts: readonly OperatorStageArtifact[]; readonly delegated_kbbl_sid: string | null; readonly worktree: OperatorStageUnit["worktree"]; readonly units: readonly OperatorStageUnit[] }
/** `run_record` is the v2 run-record projection (see below) for a run that has any `run_unit` rows; null for a run still running only under the old topology. */
export interface OperatorRunDetail { readonly id: WorkflowRunId; readonly workflow_name: string; readonly current_attempt_root_workflow_id: string; readonly attempts: readonly OperatorWorkflowAttempt[]; readonly status: OperatorRunStatus; readonly stages: readonly OperatorStageDetail[]; readonly parked_count: number; readonly updated_at: string; readonly is_stuck: boolean; readonly epic_profile: EpicWorkflowProfile | null; readonly run_record: OperatorRunRecordDetail | null }
export interface OperatorParkedGate { readonly id: string; readonly gate_type: string; readonly run_id: WorkflowRunId; readonly stage_name: string; readonly unit_id: UnitId; readonly repository_key: string | null; readonly artifact_revision_id: ArtifactId | null; readonly gate_step: string | null; readonly worktree: OperatorStageUnit["worktree"]; readonly resume_actions: readonly string[]; readonly pr_url: string | null }
export interface OperatorArtifactRevision { readonly id: ArtifactId; readonly status: "draft" | "approved" | "rejected"; readonly lifecycle: "current" | "superseded" | "withdrawn" | "released"; readonly created_at: string; readonly body: JsonValue; readonly validation: JsonValue }
export interface OperatorArtifactDetail { readonly id: ArtifactId; readonly requested_revision_id: ArtifactId; readonly current_revision_id: ArtifactId | null; readonly type_id: string; readonly component_id: string | null; readonly capabilities: { readonly reviewable: boolean; readonly commentable: boolean; readonly atom_editable: boolean; readonly review_items: boolean } | null; readonly anchor_schema: readonly string[] | null; readonly review: JsonValue | null; readonly run_id: WorkflowRunId; readonly producing_stage: string; readonly label: string | null; readonly revisions: readonly OperatorArtifactRevision[] }
export type OperatorCohortLifecycle = "waiting_admission" | "building" | "artifact_review" | "revision_requested" | "merge_confirmation" | "assessing" | "github_review" | "pull_request_mismatch" | "complete" | "failed";
export interface OperatorPullRequestObservation { readonly owner: string; readonly name: string; readonly number: number; readonly url: string; readonly head_branch: string; readonly base_branch: string; readonly state: "open" | "merged" | "closed_unmerged"; readonly observed_at: string }
export interface OperatorPullRequestMismatch { readonly kind: "missing_repository_identity" | "repository_mismatch" | "pull_request_mismatch" | "head_branch_mismatch" | "base_branch_mismatch" | "closed_without_merge" | "stale_observation"; readonly detail: string }
export interface OperatorCohortPullRequestReconciliation { readonly repository_key: string; readonly observation: OperatorPullRequestObservation; readonly mismatch: OperatorPullRequestMismatch | null; readonly completed_at: string | null; readonly updated_at: string }
export interface OperatorReviewInboxItem { readonly id: string; readonly kind: "admission" | "artifact_gate" | "merge_confirmation" | "cohort_blocked" | "cohort_failed" | "pull_request_mismatch" | "pull_request_merge" | "gate_decision"; readonly state: "actionable" | "blocked" | "completed"; readonly run_id: WorkflowRunId; readonly workflow_name: string; readonly stage_instance_id: StageInstanceId; readonly stage_name: string; readonly unit_id: UnitId; readonly repository_key: string | null; readonly title: string | null; readonly lifecycle: OperatorCohortLifecycle; readonly artifact_revision_id: ArtifactId | null; readonly artifact_url: string | null; readonly gate_id: string | null; readonly gate_url: string | null; readonly resume_actions: readonly string[]; readonly blocked_by: readonly string[]; readonly pr_url: string | null; readonly completed_at: string | null }
export interface OperatorCohortSummary { readonly id: string; readonly run_id: WorkflowRunId; readonly workflow_name: string; readonly stage_instance_id: StageInstanceId; readonly stage_name: string; readonly unit_id: UnitId; readonly repository_key: string | null; readonly title: string | null; readonly lifecycle: OperatorCohortLifecycle; readonly completion: { readonly build_complete: boolean; readonly assessment_complete: boolean }; readonly admission: { readonly required: boolean; readonly admitted: boolean; readonly eligible: boolean; readonly blocked_by: readonly string[] }; readonly artifact_revision_id: ArtifactId | null; readonly artifact_url: string | null; readonly gate_id: string | null; readonly gate_url: string | null; readonly pr_url: string | null; readonly pull_request_reconciliation: OperatorCohortPullRequestReconciliation | null; readonly updated_at: string }
export interface OperatorReviewInbox { readonly cohorts: readonly OperatorCohortSummary[]; readonly items: readonly OperatorReviewInboxItem[] }
export interface OperatorApplicationVersionInventory { readonly application_version: string | null; readonly run_count: number; readonly pending_run_count: number; readonly gated_run_count: number; readonly oldest_pending_at: string | null }

/**
 * The v2 run-record projection: everything an operator or recovery path can
 * ask about a run without reconstructing it from executor state, DBOS event
 * payloads, or workflow return values. Every field here is read straight from
 * an application-owned row — `dbos_liveness` is the one deliberate exception,
 * read through a single infrastructure adapter for diagnostics only, never to
 * decide the unit's outcome.
 */
export type OperatorRunRecordUnitDecision = "satisfied" | "waiting" | "work_available" | "work_in_progress" | "needs_work" | "failed" | "cancelled";

/** The minimal facts `selectRunRecordUnitDecision` ranks — a display label, not a scheduling input. */
export interface OperatorRunRecordUnitFacts {
  readonly unit_state: "ready" | "working" | "waiting" | "satisfied" | "failed" | "cancelled";
  readonly all_required_released: boolean;
  readonly has_open_wait: boolean;
  readonly has_available_work_order: boolean;
  readonly has_started_work_order: boolean;
}

/**
 * The same ranking `selectUnitDecision` applies to full domain rows, restated
 * over the lighter facts a display projection already has in hand. Executor
 * health, workflow return values, and DBOS status are absent by construction.
 */
export const selectRunRecordUnitDecision = (facts: OperatorRunRecordUnitFacts): OperatorRunRecordUnitDecision => {
  if (facts.unit_state === "cancelled") return "cancelled";
  if (facts.unit_state === "failed") return "failed";
  if (facts.all_required_released) return "satisfied";
  if (facts.has_open_wait) return "waiting";
  if (facts.has_available_work_order) return "work_available";
  if (facts.has_started_work_order) return "work_in_progress";
  return "needs_work";
};

export interface OperatorRunRecordSlot {
  readonly output_name: string;
  readonly artifact_type: string;
  readonly required: boolean;
  readonly state: RunOutputSlotState["kind"];
  readonly artifact_revision_id: ArtifactId | null;
  readonly version: number;
}

export interface OperatorRunRecordWait {
  readonly id: string;
  readonly output_name: string | null;
  readonly kind: "gate" | "handoff_downstream" | "handoff_external";
  readonly status: "open" | "closed";
  readonly opened_at: string;
}

export interface OperatorRunRecordWorkOrder {
  readonly id: WorkOrderId;
  readonly reason: string;
  readonly state: WorkOrderState;
  readonly workflow_id: string;
  readonly executor_health: JsonValue | null;
  readonly cleanup_state: string | null;
  /** Read once through the DBOS status adapter, for display only — see the module doc above. */
  readonly dbos_liveness: string | null;
}

export interface OperatorRunRecordUnit {
  readonly run_unit_id: RunUnitId;
  readonly unit_id: UnitId;
  readonly decision: OperatorRunRecordUnitDecision;
  readonly slots: readonly OperatorRunRecordSlot[];
  readonly waits: readonly OperatorRunRecordWait[];
  readonly work_orders: readonly OperatorRunRecordWorkOrder[];
}

export interface OperatorRunRecordTransition {
  readonly operation: string;
  readonly actor: string;
  readonly prior_record_version: number;
  readonly resulting_record_version: number;
  readonly created_at: string;
}

export interface OperatorRunRecordDetail {
  readonly run_id: WorkflowRunId;
  readonly state: string;
  readonly record_version: number;
  readonly units: readonly OperatorRunRecordUnit[];
  readonly recent_transitions: readonly OperatorRunRecordTransition[];
}
