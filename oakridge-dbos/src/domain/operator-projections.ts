import type * as V15 from "./dev-flow-v15";
import type { ExecutionId } from "./primitives";
import type { ArtifactId, CohortId, JsonValue, StageInstanceId, UnitId, WorkflowRunId, WorkOrderId } from "./primitives";
import type { BlockedReason, CoreStatus, NextActor } from "./records";

export type OperatorRunStatus = CoreStatus;
export type OperatorStageStatus = CoreStatus;
export interface OperatorRunSummary { readonly id: WorkflowRunId; readonly title: string | null; readonly repository_keys: readonly string[]; readonly workflow_name: string; readonly current_attempt_root_workflow_id: string; readonly status: OperatorRunStatus; readonly blocked_reason: BlockedReason | null; readonly next_actor: NextActor | null; readonly current_stage: string | null; readonly stage_total: number; readonly stage_complete: number; readonly attention_count: number; readonly parked_count: number; readonly updated_at: string; readonly archived: boolean }
export interface OperatorWorkflowAttempt { readonly root_workflow_id: string; readonly forked_from_root_workflow_id: string | null; readonly status: OperatorRunStatus; readonly created_at: string }
/**
 * `created_at` is when this revision was written, not when the chain began. A
 * caller wanting the chain's origin must read the chain.
 *
 * Deliberately broader than what a downstream stage may consume. `list_effective_for_run`
 * lists every revision the run holds in `current` or `released` lifecycle, which
 * includes one still parked pending its gate; `list_released_for_stage_output`
 * narrows to accepted revisions, and that is the one a consumer reads. The two
 * differ exactly while a revision is awaiting review — which is precisely what
 * the operator needs a route to, and what a downstream stage must not see yet.
 */
export interface OperatorStageArtifact { readonly cohort_id: CohortId | null; readonly id: ArtifactId; readonly type_id: string; readonly version: number; readonly label: string | null; readonly created_at: string }


/**
 * Where a session sits in the run graph, mirroring `oakridge.run_unit` reached
 * through the session's `oakridge.executor_attachment`
 * (migrations/0011_run_owned_work.sql:88-96). Unconditional by design: this
 * answers navigation ("which run is this session part of"), which stays true
 * after the work order completes and its cleanup finishes — unlike
 * `SessionHold`, which answers close-safety and must not widen.
 */
export interface OperatorSessionRunLocation {
  /** `oakridge.run_unit.run_id`. */
  readonly run_id: WorkflowRunId;
  /** `oakridge.run_unit.stage_instance_id`. */
  readonly stage_instance_id: StageInstanceId;
  /** `oakridge.stage_instance.stage_key`. */
  readonly stage_key: string;
  /** `oakridge.run_unit.unit_id`. */
  readonly unit_id: UnitId;
  /** `oakridge.work_order.id` (0011:67) — the attempt whose attachment named the session. */
  readonly work_order_id: WorkOrderId;
}
export type OperatorWorkerRecord =
  | { readonly worker: "provision"; readonly record: V15.ProvisionWorkerRecord }
  | { readonly worker: "spec"; readonly record: V15.SpecWorkerRecord }
  | { readonly worker: "plan"; readonly record: V15.PlanWorkerRecord }
  | { readonly worker: "brief"; readonly record: V15.BriefWorkerRecord }
  | { readonly worker: "build"; readonly record: V15.BuildWorkerRecord }
  | { readonly worker: "assessment"; readonly record: V15.AssessmentWorkerRecord }
  | { readonly worker: "final_integration"; readonly record: V15.FinalWorkerRecord };

export interface OperatorStageUnit { readonly workers: readonly OperatorWorkerRecord[]; readonly version: number; readonly cohort_id: CohortId; readonly unit_id: UnitId; readonly repository_key: string | null; readonly brief: import("./dev-flow-artifacts").BuildBriefBody | null; readonly sid: string | null; readonly worktree: { readonly branch: string; readonly path: string; readonly base_ref: string } | null; readonly base_sha: string | null; readonly state: string; readonly status: OperatorStageStatus; readonly blocked_reason: BlockedReason | null; readonly next_actor: NextActor | null; readonly retryable: boolean; readonly gate: string | null; readonly merge_head_drift?: { readonly accepted_head_sha: string; readonly merged_head_sha: string } }
export interface OperatorStageDetail { readonly stage_instance_id: StageInstanceId; readonly name: string; readonly type: string; readonly operator_role: string | null; readonly status: OperatorStageStatus; readonly blocked_reason: BlockedReason | null; readonly next_actor: NextActor | null; readonly artifacts: readonly OperatorStageArtifact[]; readonly delegated_kbbl_sid: string | null; readonly worktree: OperatorStageUnit["worktree"]; readonly units: readonly OperatorStageUnit[] }
/**
 * `epic_profile` and `run_record` are gone from this payload. Both were already
 * hardcoded `null` by the v15 projection — the profile table does not exist, and
 * the run-record projection described `run_unit`/`run_output_slot`/`work_order`,
 * none of which v15 has. kbbl declares both optional and reads neither.
 */
export interface OperatorRunDetail { readonly id: WorkflowRunId; readonly title: string | null; readonly repository_keys: readonly string[]; readonly workflow_name: string; readonly current_attempt_root_workflow_id: string; readonly attempts: readonly OperatorWorkflowAttempt[]; readonly status: OperatorRunStatus; readonly blocked_reason: BlockedReason | null; readonly next_actor: NextActor | null; readonly stages: readonly OperatorStageDetail[]; readonly parked_count: number; readonly updated_at: string }
/**
 * A gate that is open is listed whatever its run's state (spec §1 rule 9 —
 * the operator projection never hides a fact because of the state of its
 * parent). `run_state` says what the run is doing; `actionable` says whether
 * an operator's decision on this gate can still take effect, so kbbl can
 * render a gate stranded by a failed or cancelled run instead of hiding it.
 */
export interface OperatorParkedGate { readonly id: string; readonly stage_instance_id: StageInstanceId | null; readonly gate_type: string; readonly run_id: WorkflowRunId; readonly stage_name: string; readonly unit_id: UnitId; readonly repository_key: string | null; readonly artifact_revision_id: ArtifactId | null; readonly artifact_revision_ids: readonly ArtifactId[]; readonly gate_step: string | null; readonly worktree: OperatorStageUnit["worktree"]; readonly resume_actions: readonly string[]; readonly pr_url: string | null; readonly run_state: CoreStatus; readonly actionable: boolean }

export interface OperatorRunDiagnosisSession {
  readonly session_id: string;
  readonly stage_key: string;
  readonly cohort_id: CohortId;
  readonly cohort_key: string;
  readonly worker: V15.V15WorkerKey;
  readonly execution_id: ExecutionId;
  readonly action_point: string;
  readonly is_current: boolean;
  readonly status: CoreStatus;
}
export interface OperatorRunDiagnosisGate extends OperatorParkedGate { readonly cohort_id: CohortId | null }
export interface OperatorPullRequestMergeWait { readonly cohort_id: CohortId; readonly stage_instance_id: StageInstanceId; readonly unit_id: UnitId; readonly pull_request_url: string }
export interface OperatorRunDiagnosisArtifact { readonly artifact_id: ArtifactId; readonly type_id: string; readonly revision: number; readonly stage_name: string; readonly label: string | null; readonly created_at: string }
export interface OperatorRunDiagnosisProgress { readonly total: number; readonly pending: number; readonly active: number; readonly blocked: number; readonly complete: number; readonly failed: number; readonly cancelled: number }
/**
 * One committed diagnosis read used by every run-workspace view.
 *
 * Inventory of the retired read-time answers: the run/stage/unit selectors
 * produced lifecycle status; the cohort projection produced lifecycle,
 * admission, gate, artifact, pull-request and completion facts; run-attention
 * counted actionable gates and stuck work; run-overview joined run identity,
 * session attempts, current/actionable sessions, gates, artifacts and stage
 * progress. These named members preserve every distinct fact in one payload.
 */
export interface OperatorRunDiagnosis {
  readonly run: OperatorRunDetail;
  readonly sessions: readonly OperatorRunDiagnosisSession[];
  readonly current_session: OperatorRunDiagnosisSession | null;
  readonly sessions_awaiting_action: readonly OperatorRunDiagnosisSession[];
  readonly active_gates: readonly OperatorRunDiagnosisGate[];
  readonly pull_request_merge_waits: readonly OperatorPullRequestMergeWait[];
  readonly recent_artifacts: readonly OperatorRunDiagnosisArtifact[];
  readonly stage_progress: OperatorRunDiagnosisProgress;
}

/** A gate's decision only takes effect while its run is still active. */
export const selectGateActionability = (run_state: CoreStatus): boolean => run_state === "active" || run_state === "blocked";
export interface OperatorArtifactRevision { readonly id: ArtifactId; readonly status: V15.ArtifactState; readonly lifecycle: "current" | "superseded" | "withdrawn" | "released"; readonly created_at: string; readonly body: JsonValue; readonly validation: JsonValue }
export interface OperatorArtifactDetail { readonly review_error: { readonly detail: string } | null; readonly review_context: import("./v15-operator-review").OperatorArtifactReviewContext | null; readonly id: ArtifactId; readonly requested_revision_id: ArtifactId; readonly current_revision_id: ArtifactId | null; readonly type_id: string; readonly component_id: string | null; readonly capabilities: { readonly reviewable: boolean; readonly commentable: boolean; readonly atom_editable: boolean; readonly review_items: boolean } | null; readonly anchor_schema: readonly string[] | null; readonly review: JsonValue | null; readonly run_id: WorkflowRunId; readonly producing_stage: string; readonly label: string | null; readonly revisions: readonly OperatorArtifactRevision[] }
export type OperatorCohortLifecycle = CoreStatus;
export interface OperatorPullRequestObservation { readonly owner: string; readonly name: string; readonly number: number; readonly url: string; readonly head_branch: string; readonly base_branch: string; readonly state: "open" | "merged" | "closed_unmerged"; readonly observed_at: string }
export interface OperatorPullRequestMismatch { readonly kind: "missing_repository_identity" | "repository_mismatch" | "pull_request_mismatch" | "head_branch_mismatch" | "base_branch_mismatch" | "closed_without_merge" | "stale_observation"; readonly detail: string }
export interface OperatorCohortPullRequestReconciliation { readonly repository_key: string; readonly observation: OperatorPullRequestObservation; readonly mismatch: OperatorPullRequestMismatch | null; readonly completed_at: string | null; readonly updated_at: string }
export interface OperatorReviewInboxItem { readonly id: string; readonly kind: "artifact_gate" | "merge_confirmation" | "cohort_blocked" | "cohort_failed" | "cohort_retry" | "pull_request_mismatch" | "pull_request_merge"; readonly state: "actionable" | "blocked"; readonly run_id: WorkflowRunId; readonly workflow_name: string; readonly stage_instance_id: StageInstanceId; readonly stage_name: string; readonly unit_id: UnitId; readonly repository_key: string | null; readonly title: string | null; readonly lifecycle: OperatorCohortLifecycle; readonly blocked_reason: BlockedReason | null; readonly next_actor: NextActor | null; readonly artifact_revision_id: ArtifactId | null; readonly artifact_revision_ids?: readonly ArtifactId[]; readonly artifact_url: string | null; readonly gate_id: string | null; readonly gate_url: string | null; readonly resume_actions: readonly string[]; readonly blocked_by: readonly string[]; readonly pr_url: string | null }
export interface CohortDetailLink { readonly key: string; readonly label: string; readonly url: string }
export interface CohortDetailFact { readonly key: string; readonly label: string; readonly value: string }
export interface CohortDetail { readonly links: readonly CohortDetailLink[]; readonly facts: readonly CohortDetailFact[] }
export interface CohortDetailContributor {
  readonly stage_type: string;
  read(cohort_ids: readonly CohortId[]): Promise<ReadonlyMap<CohortId, CohortDetail>>;
  cursor(): Promise<string>;
  enrich_run?(run: OperatorRunDetail): Promise<OperatorRunDetail>;
}
export interface OperatorCohortSummary { readonly id: string; readonly run_id: WorkflowRunId; readonly workflow_name: string; readonly stage_instance_id: StageInstanceId; readonly stage_name: string; readonly unit_id: UnitId; readonly repository_key: string | null; readonly title: string | null; readonly lifecycle: OperatorCohortLifecycle; readonly blocked_reason: BlockedReason | null; readonly next_actor: NextActor | null; readonly completion: { readonly build_complete: boolean; readonly assessment_complete: boolean }; readonly blocked_by: readonly string[]; readonly artifact_revision_id: ArtifactId | null; readonly artifact_url: string | null; readonly gate_id: string | null; readonly gate_url: string | null; readonly links: readonly CohortDetailLink[]; readonly facts: readonly CohortDetailFact[]; readonly updated_at: string }

export const selectPullRequestMergeWaits = (cohorts: readonly OperatorCohortSummary[]): readonly OperatorPullRequestMergeWait[] =>
  cohorts.filter((cohort) => cohort.lifecycle === "blocked" && cohort.blocked_reason === "external"
    && cohort.next_actor === "external" && cohort.links.some((link) => link.key === "pull_request"))
    .map((cohort) => ({ cohort_id: cohort.id as CohortId, stage_instance_id: cohort.stage_instance_id,
      unit_id: cohort.unit_id, pull_request_url: cohort.links.find((link) => link.key === "pull_request")!.url }));
/** The items list is the required-attention decision queue; completed and optional-attention history lives outside the inbox. */
export interface OperatorReviewInbox { readonly cohorts: readonly OperatorCohortSummary[]; readonly items: readonly OperatorReviewInboxItem[]; readonly attention_count: number }
export interface OperatorApplicationVersionInventory { readonly application_version: string | null; readonly run_count: number; readonly pending_run_count: number; readonly gated_run_count: number; readonly oldest_pending_at: string | null }


/** Canonical prerequisite order, shared by pending and materialized stage projections. */
export const selectV15StageOrder = (definition: V15.WorkflowDefinition): readonly V15.StageKey[] => {
  const remaining = new Set(Object.keys(definition.stages) as V15.StageKey[]);
  const order: V15.StageKey[] = [];
  while (remaining.size) {
    const ready = [...remaining].filter((key) => definition.stages[key].prerequisites.every((dependency) => order.includes(dependency))).sort();
    if (!ready.length) throw new Error("stored stage prerequisites contain a cycle");
    for (const key of ready) { order.push(key); remaining.delete(key); }
  }
  return order;
};
