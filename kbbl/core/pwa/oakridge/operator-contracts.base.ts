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

/** Mirrors oakridge-dbos definition bundle, run/scope projections and scope command HTTP contract. */
export type OperatorSchemaShape =
  | { readonly kind: "boolean" }
  | { readonly kind: "integer"; readonly min: number; readonly max: number }
  | { readonly kind: "string"; readonly min_length: number; readonly max_length: number }
  | { readonly kind: "enum"; readonly variants: readonly string[] }
  | { readonly kind: "record"; readonly fields: readonly OperatorSchemaField[]; readonly dictionary?: string | null }
  | { readonly kind: "list"; readonly item: string; readonly max_items: number }
  | { readonly kind: "optional"; readonly item: string }
  | { readonly kind: "union"; readonly variants: readonly { readonly key: string; readonly schema: string }[] }
  | { readonly kind: "reference"; readonly brand: "instance" | "execution" | "artifact_revision" | "resource" };
export interface OperatorSchemaField { readonly key: string; readonly schema: string; readonly required: boolean }
export interface OperatorSchema { readonly key: string; readonly shape: OperatorSchemaShape }
export interface OperatorPresentation { readonly label: string; readonly viewer?: string | null }
export interface OperatorCommandDescriptor {
  readonly key: string; readonly label: string; readonly consequence: string; readonly payload_schema: string;
  readonly field_presentation: readonly { readonly key: string; readonly presentation: OperatorPresentation }[];
  readonly targets: readonly unknown[];
}
export interface OperatorScopeDefinition {
  readonly key: string; readonly presentation: OperatorPresentation;
  readonly commands: readonly OperatorCommandDescriptor[];
  readonly outputs: readonly { readonly key: string; readonly schema: string }[];
}
export interface OperatorPinnedDefinition {
  readonly bundle_id: string; readonly digest: string;
  readonly source: { readonly schemas: readonly OperatorSchema[]; readonly scopes: readonly OperatorScopeDefinition[] };
}
export interface OperatorGenericRun {
  readonly run_id: string; readonly scopes: readonly { readonly scope_id: string; readonly scope_key: string; readonly label: string;
    readonly version: number; readonly is_terminal: boolean; readonly available_commands: readonly string[] }[];
}
export interface OperatorCheckedValue { readonly schema: string; readonly data: OperatorCheckedData }
export type OperatorCheckedData =
  | { readonly kind: "boolean" | "integer" | "string"; readonly value: boolean | number | string }
  | { readonly kind: "enum"; readonly variant: string }
  | { readonly kind: "record"; readonly fields: readonly { readonly field_id: number; readonly value: OperatorCheckedValue | null }[]; readonly dictionary: readonly { readonly key: string; readonly value: OperatorCheckedValue }[] }
  | { readonly kind: "list"; readonly items: readonly OperatorCheckedValue[] }
  | { readonly kind: "optional"; readonly value?: OperatorCheckedValue | null }
  | { readonly kind: "variant"; readonly variant: string; readonly value: OperatorCheckedValue }
  | { readonly kind: "reference"; readonly brand: string; readonly id: string };
export interface OperatorTargetRevision { readonly identity: string; readonly version: number }
/** Mirrors authority.artifact_revision in the scope projection. */
export interface OperatorArtifactRevision {
  readonly id: string; readonly version: number; readonly scope_id: string; readonly execution_id: string | null;
  readonly output_key: string; readonly collection_key: string | null; readonly body: OperatorCheckedValue;
  readonly predecessor_id: string | null;
}
export interface OperatorOutputSlot {
  readonly id: string; readonly version: number; readonly output_key: string; readonly collection_key: string;
  readonly current_revision_id: string | null; readonly current_revision: OperatorArtifactRevision | null;
}
export interface OperatorScopeView {
  readonly scope_id: string; readonly run_id: string; readonly scope_key: string; readonly label: string;
  readonly state: OperatorCheckedValue; readonly outcome: OperatorCheckedValue | null; readonly is_terminal: boolean;
  readonly commands: readonly OperatorCommandDescriptor[];
  readonly outputs: readonly OperatorOutputSlot[];
  readonly executions: readonly { readonly id: string; readonly version: number; readonly worker_key: string; readonly status: string; readonly result: OperatorCheckedValue | null }[];
  readonly cursor: { readonly scope_version: number; readonly transition_id: string | null };
  /** m5-generic-api supplies observed revision identities for each available command. */
  readonly command_targets?: Readonly<{ readonly [commandKey: string]: readonly OperatorTargetRevision[] }>;
}
export interface OperatorDraftKey { readonly run_id: string; readonly scope_id: string; readonly command_key: string;
  readonly owner_version: number; readonly targets: readonly OperatorTargetRevision[] }
export interface OperatorCommandSubmission extends OperatorDraftKey {
  readonly request_id: string; readonly payload: unknown;
}
export interface OperatorCommandReceipt { readonly kind: "accepted_pending"; readonly request_id: string;
  readonly transition_id: string; readonly scope_version: number }

/** Mirrors oakridge-dbos/src/projections/inbox.ts. */
export type OperatorInboxItem =
  | { readonly kind: "command"; readonly run_id: string; readonly scope_id: string; readonly scope_version: number; readonly key: string; readonly label: string; readonly consequence: string }
  | { readonly kind: "wait"; readonly run_id: string; readonly scope_id: string; readonly scope_version: number; readonly reason: string; readonly label: string }
  | { readonly kind: "diagnostic"; readonly run_id: string; readonly scope_id: string; readonly scope_version: number; readonly detail: string };
export interface OperatorInbox { readonly cursor: readonly { readonly scope_id: string; readonly version: number }[]; readonly items: readonly OperatorInboxItem[] }

export interface OperatorInboxPage extends OperatorInbox { readonly next_cursor: string | null }
