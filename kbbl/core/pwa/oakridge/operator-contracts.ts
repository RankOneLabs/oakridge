/** Read-only descriptors of the operator HTTP responses at base 487beef2.
 * These carry presentation data, never interpreter types or progression rules. */
import type { CoreStatus, BlockedReason, NextActor, OperatorWorkerRecord, WorkerKey, BuildBriefDescriptor } from "./operator-worker-types";
export interface OperatorRunSummary { readonly id: string; readonly title: string | null; readonly repository_keys: readonly string[]; readonly workflow_name: string; readonly current_attempt_root_workflow_id: string; readonly status: CoreStatus; readonly blocked_reason: BlockedReason | null; readonly next_actor: NextActor | null; readonly current_stage: string | null; readonly stage_total: number; readonly stage_complete: number; readonly attention_count: number; readonly parked_count: number; readonly updated_at: string; readonly archived: boolean }
export interface OperatorStageArtifact { readonly cohort_id: string | null; readonly id: string; readonly type_id: string; readonly version: number; readonly label: string | null; readonly created_at: string }
export interface OperatorSessionRunLocation {
  /** `oakridge.run_unit.run_id`. */
  readonly run_id: string;
  /** `oakridge.run_unit.stage_instance_id`. */
  readonly stage_instance_id: string;
  /** `oakridge.stage_instance.stage_key`. */
  readonly stage_key: string;
  /** `oakridge.run_unit.unit_id`. */
  readonly unit_id: string;
  /** `oakridge.work_order.id` (0011:67) — the attempt whose attachment named the session. */
  readonly work_order_id: string;
}
export interface OperatorStageUnit { readonly workers: readonly OperatorWorkerRecord[]; readonly version: number; readonly cohort_id: string; readonly unit_id: string; readonly repository_key: string | null; readonly brief: BuildBriefDescriptor | null; readonly sid: string | null; readonly worktree: { readonly branch: string; readonly path: string; readonly base_ref: string } | null; readonly base_sha: string | null; readonly state: string; readonly status: CoreStatus; readonly blocked_reason: BlockedReason | null; readonly next_actor: NextActor | null; readonly retryable: boolean; readonly gate: string | null; readonly merge_head_drift?: { readonly accepted_head_sha: string; readonly merged_head_sha: string } }
export interface OperatorStageDetail { readonly stage_instance_id: string; readonly name: string; readonly type: string; readonly operator_role: string | null; readonly status: CoreStatus; readonly blocked_reason: BlockedReason | null; readonly next_actor: NextActor | null; readonly artifacts: readonly OperatorStageArtifact[]; readonly delegated_kbbl_sid: string | null; readonly worktree: OperatorStageUnit["worktree"]; readonly units: readonly OperatorStageUnit[] }
export interface OperatorRunDetail { readonly id: string; readonly title: string | null; readonly repository_keys: readonly string[]; readonly workflow_name: string; readonly current_attempt_root_workflow_id: string; readonly attempts: readonly OperatorWorkflowAttempt[]; readonly status: CoreStatus; readonly blocked_reason: BlockedReason | null; readonly next_actor: NextActor | null; readonly stages: readonly OperatorStageDetail[]; readonly parked_count: number; readonly updated_at: string }
export interface OperatorParkedGate { readonly id: string; readonly stage_instance_id: string | null; readonly gate_type: string; readonly run_id: string; readonly stage_name: string; readonly unit_id: string; readonly repository_key: string | null; readonly artifact_revision_id: string | null; readonly artifact_revision_ids: readonly string[]; readonly gate_step: string | null; readonly worktree: OperatorStageUnit["worktree"]; readonly resume_actions: readonly string[]; readonly pr_url: string | null; readonly run_state: CoreStatus; readonly actionable: boolean }
export interface OperatorRunDiagnosisSession {
  readonly session_id: string;
  readonly stage_key: string;
  readonly cohort_id: string;
  readonly cohort_key: string;
  readonly worker: WorkerKey;
  readonly execution_id: string;
  readonly action_point: string;
  readonly is_current: boolean;
  readonly status: CoreStatus;
}
export interface OperatorPullRequestMergeWait { readonly cohort_id: string; readonly stage_instance_id: string; readonly unit_id: string; readonly pull_request_url: string }
export interface OperatorRunDiagnosisArtifact { readonly artifact_id: string; readonly type_id: string; readonly revision: number; readonly stage_name: string; readonly label: string | null; readonly created_at: string }
export interface OperatorRunDiagnosisProgress { readonly total: number; readonly pending: number; readonly active: number; readonly blocked: number; readonly complete: number; readonly failed: number; readonly cancelled: number }
export interface OperatorRunDiagnosis {
  readonly run: OperatorRunDetail;
  readonly sessions: readonly OperatorRunDiagnosisSession[];
  readonly current_session: OperatorRunDiagnosisSession | null;
  readonly sessions_awaiting_action: readonly OperatorRunDiagnosisSession[];
  readonly active_gates: readonly (OperatorParkedGate & { readonly cohort_id: string | null })[];
  readonly pull_request_merge_waits: readonly OperatorPullRequestMergeWait[];
  readonly recent_artifacts: readonly OperatorRunDiagnosisArtifact[];
  readonly stage_progress: OperatorRunDiagnosisProgress;
}
export interface OperatorCohortSummary { readonly id: string; readonly run_id: string; readonly workflow_name: string; readonly stage_instance_id: string; readonly stage_name: string; readonly unit_id: string; readonly repository_key: string | null; readonly title: string | null; readonly lifecycle: CoreStatus; readonly blocked_reason: BlockedReason | null; readonly next_actor: NextActor | null; readonly completion: { readonly build_complete: boolean; readonly assessment_complete: boolean }; readonly blocked_by: readonly string[]; readonly artifact_revision_id: string | null; readonly artifact_url: string | null; readonly gate_id: string | null; readonly gate_url: string | null; readonly links: readonly CohortDetailLink[]; readonly facts: readonly CohortDetailFact[]; readonly updated_at: string }
export interface OperatorReviewInboxItem { readonly id: string; readonly kind: "artifact_gate" | "merge_confirmation" | "cohort_blocked" | "cohort_failed" | "cohort_retry" | "pull_request_mismatch" | "pull_request_merge"; readonly state: "actionable" | "blocked"; readonly run_id: string; readonly workflow_name: string; readonly stage_instance_id: string; readonly stage_name: string; readonly unit_id: string; readonly repository_key: string | null; readonly title: string | null; readonly lifecycle: CoreStatus; readonly blocked_reason: BlockedReason | null; readonly next_actor: NextActor | null; readonly artifact_revision_id: string | null; readonly artifact_revision_ids?: readonly string[]; readonly artifact_url: string | null; readonly gate_id: string | null; readonly gate_url: string | null; readonly resume_actions: readonly string[]; readonly blocked_by: readonly string[]; readonly pr_url: string | null }
export interface OperatorReviewInbox { readonly cohorts: readonly OperatorCohortSummary[]; readonly items: readonly OperatorReviewInboxItem[]; readonly attention_count: number }
export interface CohortDetailLink { readonly key: string; readonly label: string; readonly url: string }
export interface CohortDetailFact { readonly key: string; readonly label: string; readonly value: string }

interface OperatorWorkflowAttempt { readonly root_workflow_id: string; readonly forked_from_root_workflow_id: string | null; readonly status: CoreStatus; readonly created_at: string }
