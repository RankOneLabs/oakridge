import type { ArtifactId, ExecutionId, JsonValue, StageInstanceId, UnitId, WorkflowDefinitionId, WorkflowRunId } from "../domain/primitives";
import type { StageInstance, StageOutcome, WorkflowDefinition } from "../domain/workflow";
import type { EpicWorkflowProfile, EpicWorkflowProfileId } from "../domain/epic";
import type { GateDecisionAudit, GateDecisionAuditId } from "../domain/gates";
import type { CollaborationMessage, CollaborationThread, CollaborationThreadWithMessages, MessageId, ReviewItem, ReviewItemId, ReviewItemStatus, ThreadId, ThreadStatus } from "../domain/collaboration";
import type { ArtifactCoordinate, ArtifactEmission, ArtifactEmissionDelivery, ArtifactRevision, EmitArtifactRevisionResult, PendingArtifactNotification, ReleaseArtifactResult, WithdrawArtifactRequest, WithdrawArtifactResult } from "../domain/artifacts";
import type { CompiledOutputContract } from "../domain/compiled-workflow";
import type { ArtifactEnvelope } from "../domain/execution";
import type { ExecutionRequest, ExecutorTerminalObservation, ExternalExecutionReference } from "../domain/execution";
import type { CancellationExecutionTarget, CancellationWaitTarget, UnitRerunTarget } from "../domain/rerun";
import type { SessionHold } from "../domain/session-hold";
import type { CreateProject, Project } from "../domain/projects";
import type { AdmitStageUnitRequest, AdmitStageUnitResult, CreateWorkflowRunResult, DeleteRunResult, PendingRunLaunch, PersistWorkflowRunLaunch, SetRunArchiveResult, WorkflowRunLaunchRecord, WorkflowRunListFilter } from "../domain/runs";
import type { ConfirmFinalPullRequestRequest, FinalPullRequestDomainError, FinalPullRequestProjection, PullRequestObservation } from "../domain/final-pull-request";
import type { CohortPullRequestReconciliation } from "../domain/cohort-pull-request";
import type { CloseWaitRequest, OpenGateWaitInput, OpenHandoffDownstreamWaitInput, Wait, WaitClosesOn, WaitOutcome } from "../domain/wait";
import type { Result } from "../domain/primitives";
import type { CloseRunOutputWait, CloseRunOutputWaitResult, ExecutorAttachment, ExecutorHealthObservation, FailRunMaterialization, InitializeStraightThroughRun, PersistMaterializedStage, PublishWorkOrderArtifact, PublishWorkOrderArtifactResult, RetryRunUnit, RetryRunUnitResult, ReviseRunUnitInput, ReviseRunUnitInputResult, RunDecision, RunMaterializationRecord, WorkOrderExecution } from "../domain/run-record";
import type { WorkOrderId, WorkflowRunId as RunRecordWorkflowRunId } from "../domain/primitives";

export interface WorkflowDefinitionRepository {
  insert_immutable(definition: WorkflowDefinition): Promise<WorkflowDefinition>;
  find_by_id(id: WorkflowDefinitionId): Promise<WorkflowDefinition | null>;
  find_by_name_version(name: string, version: number): Promise<WorkflowDefinition | null>;
  list(include_archived?: boolean): Promise<readonly WorkflowDefinition[]>;
  set_archived(id: WorkflowDefinitionId, archived: boolean): Promise<WorkflowDefinition | null>;
}

export interface ProjectRepository {
  insert(project: CreateProject): Promise<Project>;
  list(): Promise<readonly Project[]>;
  find_by_id(id: import("../domain/primitives").ProjectId): Promise<Project | null>;
}

export interface WorkflowRunLaunch {
  readonly id: WorkflowRunId;
  readonly workflow_definition_id: WorkflowDefinitionId;
  readonly context: JsonValue;
}

export interface WorkflowRunRecord extends WorkflowRunLaunch {
  readonly context: JsonValue;
  readonly archived: boolean;
}

export interface WorkflowRunRepository {
  insert_launch(launch: WorkflowRunLaunch): Promise<void>;
  find_by_id(id: WorkflowRunId): Promise<WorkflowRunRecord | null>;
  create_with_initial_attempt(input: PersistWorkflowRunLaunch): Promise<CreateWorkflowRunResult>;
  find_launch_by_id(id: WorkflowRunId): Promise<WorkflowRunLaunchRecord | null>;
  list(filter?: WorkflowRunListFilter): Promise<readonly WorkflowRunLaunchRecord[]>;
  set_archived(id: WorkflowRunId, archived: boolean): Promise<SetRunArchiveResult>;
  delete_terminal(id: WorkflowRunId): Promise<DeleteRunResult>;
  claim_pending_launches(worker_id: string, claimed_at: string, claimed_until: string, limit: number): Promise<readonly PendingRunLaunch[]>;
  mark_launch_delivered(id: string, worker_id: string, delivered_at: string): Promise<void>;
  mark_launch_failed(id: string, worker_id: string, error: string, next_attempt_at: string): Promise<void>;
}

/** The single transactional boundary workflows ask for v2 run truth. */
export interface RunRecordRepository {
  initialize_straight_through(input: InitializeStraightThroughRun): Promise<void>;
  persist_materialized_stage(input: PersistMaterializedStage): Promise<void>;
  revise_unit_input(input: ReviseRunUnitInput): Promise<ReviseRunUnitInputResult>;
  retry_unit(input: RetryRunUnit, retried_at: string): Promise<RetryRunUnitResult>;
  admit_unit(request: AdmitStageUnitRequest, admitted_at: string): Promise<AdmitStageUnitResult>;
  decide_run(run_id: RunRecordWorkflowRunId, decided_at: string): Promise<Result<RunDecision, RunRecordRepositoryError>>;
  load_materialization_record(run_id: RunRecordWorkflowRunId): Promise<RunMaterializationRecord | null>;
  load_work_order_capability_seed(): Promise<string>;
  fail_materialization(input: FailRunMaterialization): Promise<void>;
  find_work_order_execution(work_order_id: WorkOrderId): Promise<WorkOrderExecution | null>;
  find_work_order_attachment(work_order_id: WorkOrderId): Promise<ExecutorAttachment | null>;
  /**
   * Records an artifact fact under a work order's capability, atomically with
   * the effect its declared release policy has on the slot: an `immediate`
   * output releases directly; a `gate` or `handoff` output parks the slot
   * `pending` and opens the wait that will decide it.
   */
  publish_artifact(request: PublishWorkOrderArtifact): Promise<PublishWorkOrderArtifactResult>;
  /** The gate/handoff command that owns a pending slot's wait, closing it and applying the matching release/invalidation atomically. */
  close_output_wait(request: CloseRunOutputWait): Promise<CloseRunOutputWaitResult>;
  ensure_executor_attachment(work_order_id: WorkOrderId, executor_type: string, updated_at: string): Promise<ExecutorAttachment>;
  attach_external(work_order_id: WorkOrderId, reference: ExternalExecutionReference, updated_at: string): Promise<void>;
  observe_executor(work_order_id: WorkOrderId, health: ExecutorHealthObservation, updated_at: string): Promise<void>;
  request_cleanup(work_order_id: WorkOrderId, updated_at: string): Promise<void>;
  finish_cleanup(work_order_id: WorkOrderId, succeeded: boolean, updated_at: string): Promise<void>;
}

export interface RunRecordRepositoryError {
  readonly operation: "decide_run";
  readonly run_id: RunRecordWorkflowRunId;
  readonly kind: "run_not_found" | "record_corrupt";
  readonly detail: string;
}

export interface WorkflowAttempt {
  readonly root_workflow_id: string;
  readonly run_id: WorkflowRunId;
  readonly forked_from_root_workflow_id: string | null;
  readonly created_at: string;
}

export interface WorkflowAttemptRepository {
  insert(attempt: WorkflowAttempt): Promise<void>;
  find_by_root_workflow_id(root_workflow_id: string): Promise<WorkflowAttempt | null>;
  list_for_run(run_id: WorkflowRunId): Promise<readonly WorkflowAttempt[]>;
  finish(root_workflow_id: string, ended_at: string, outcome: StageOutcome): Promise<void>;
}

export interface StartStageInstance {
  readonly id: StageInstanceId;
  readonly run_id: WorkflowRunId;
  readonly stage_key: string;
  readonly stage_type: string;
  readonly stage_contract: JsonValue;
  readonly attempt_root_workflow_id: string;
  readonly coordinator_workflow_id: string;
  readonly started_at: string;
}

export interface StageInstanceRepository {
  start(input: StartStageInstance): Promise<StageInstance>;
  finish(id: StageInstanceId, ended_at: string, outcome: StageOutcome): Promise<StageInstance>;
  find_by_id(id: StageInstanceId): Promise<StageInstance | null>;
}

export interface StageAdmissionTargetRepository {
  find_coordinator_workflow_id(stage_instance_id: StageInstanceId): Promise<string | null>;
}

/**
 * The record of gate and handoff waits — one table, written by the two
 * workflows that own them, read by everyone else. Opens are absorbed on
 * (command_workflow_id, kind) so a retried step never double-records; a close
 * with no row to close throws, because that is record corruption, not a miss.
 */
export interface WaitRepository {
  open_gate(input: OpenGateWaitInput): Promise<void>;
  open_handoff_downstream(input: OpenHandoffDownstreamWaitInput): Promise<void>;
  close(command_workflow_id: string, request: CloseWaitRequest): Promise<void>;
  /** Closes the downstream row as decided and opens the external row, in one transaction. */
  release_downstream(
    command_workflow_id: string,
    decided_outcome: Extract<WaitOutcome, { kind: "decided" }>,
    external_closes_on: Extract<WaitClosesOn, { kind: "handoff_external" }>,
  ): Promise<void>;
  find_gate_wait(artifact_revision_id: ArtifactId, gate_step: string, execution_workflow_id: string): Promise<Wait | null>;
  find_handoff_waits(artifact_revision_id: ArtifactId, execution_workflow_id: string): Promise<readonly Wait[]>;
  /** Every handoff row on one artifact revision, whichever execution produced it — a revision id is unique. */
  find_handoff_waits_for_artifact(artifact_revision_id: ArtifactId): Promise<readonly Wait[]>;
  count_open_waits(command_workflow_id: string): Promise<number>;
  /** Cancellation closing a provably dead owner's open rows as withdrawn — the single exception to owner-closes. */
  close_orphaned(command_workflow_id: string, at: string): Promise<void>;
}

export interface ArtifactRevisionRepository {
  emit_revision(id: ArtifactId, emission: ArtifactEmission, created_at: string, delivery: ArtifactEmissionDelivery): Promise<EmitArtifactRevisionResult>;
  withdraw(request: WithdrawArtifactRequest): Promise<WithdrawArtifactResult>;
  mark_released(id: ArtifactId, released_at: string): Promise<ReleaseArtifactResult>;
  find_tip(coordinate: ArtifactCoordinate): Promise<ArtifactRevision | null>;
  find_current(coordinate: ArtifactCoordinate): Promise<ArtifactRevision | null>;
  list_chain(chain_id: ArtifactId): Promise<readonly ArtifactRevision[]>;
  find_by_id(id: ArtifactId): Promise<ArtifactRevision | null>;
}

export interface RunArtifactReadRepository {
  list_effective_for_run(run_id: WorkflowRunId): Promise<readonly ArtifactRevision[]>;
}

export interface CommandOutboxMaintenanceRepository {
  purge_delivered_commands(delivered_before: string): Promise<number>;
}

export interface ArtifactNotificationRepository {
  claim_pending_notifications(worker_id: string, claimed_at: string, claimed_until: string, limit: number): Promise<readonly PendingArtifactNotification[]>;
  mark_notification_delivered(id: string, worker_id: string, delivered_at: string): Promise<void>;
  mark_notification_failed(id: string, worker_id: string, error: string, next_attempt_at: string): Promise<void>;
}

export interface ResumeArtifactRepository {
  list_latest_for_stages(run_id: WorkflowRunId, stage_keys: readonly string[]): Promise<readonly (ArtifactRevision & { readonly stage_key: string })[]>;
}

export interface ExecutionArtifactContext {
  readonly run_id: WorkflowRunId;
  readonly stage_key: string;
  readonly operator_role: string | null;
  readonly stage_instance_id: StageInstanceId;
  readonly execution_id: ExecutionId;
  readonly unit_id: UnitId;
  readonly executor_type: string;
  readonly execution_workflow_id: string;
  readonly inputs: readonly ArtifactEnvelope[];
  readonly outputs: readonly CompiledOutputContract[];
}

export interface ExecutionArtifactContextRepository {
  find_for_emit(stage_instance_id: StageInstanceId, unit_id: UnitId): Promise<ExecutionArtifactContext | null>;
}

export interface ExecutionProjectionRepository {
  record(request: ExecutionRequest, execution_workflow_id: string, parameters: JsonValue): Promise<void>;
  attach_external(execution_id: ExecutionId, reference: ExternalExecutionReference): Promise<void>;
  record_terminal(execution_id: ExecutionId, observation: ExecutorTerminalObservation): Promise<void>;
  find_external(execution_id: ExecutionId): Promise<{ readonly executor_type: string; readonly external_reference: ExternalExecutionReference } | null>;
}

export interface RerunTargetRepository {
  find_unit_target(stage_instance_id: StageInstanceId, unit_id: UnitId): Promise<UnitRerunTarget | null>;
  replace_execution_workflow(execution_id: ExecutionId, replacement_workflow_id: string): Promise<void>;
}

export interface SessionHoldRepository {
  /** The live execution holding this agent session, if any. */
  find_session_hold(session_id: string): Promise<SessionHold | null>;
}

export interface CancellationTargetRepository {
  list_for_attempt(root_workflow_id: string): Promise<readonly CancellationExecutionTarget[]>;
  terminalize_pending_waits(root_workflow_id: string, actor: string, reason: string, withdrawn_at: string): Promise<readonly CancellationWaitTarget[]>;
  finish_started_stages(root_workflow_id: string, ended_at: string, reason: string | null): Promise<void>;
}

export interface GateDecisionAuditRepository {
  insert_idempotent(audit: GateDecisionAudit): Promise<GateDecisionAuditId>;
  mark_applied(id: GateDecisionAuditId, applied_at: string): Promise<void>;
  find_by_idempotency_key(idempotency_key: string): Promise<GateDecisionAudit | null>;
  find_for_revision(artifact_revision_id: ArtifactId): Promise<GateDecisionAudit | null>;
}

export interface EpicWorkflowProfileRepository {
  insert(profile: EpicWorkflowProfile): Promise<void>;
  find_by_id(id: EpicWorkflowProfileId): Promise<EpicWorkflowProfile | null>;
  /**
   * A profile is created with its run's id, so the two lookups agree today —
   * but that is an accident of the launch path, not a rule, and a caller
   * holding a run should say so rather than rely on it.
   */
  find_by_run_id(run_id: WorkflowRunId): Promise<EpicWorkflowProfile | null>;
}

/**
 * The durable record of whether a cohort's pull request merged, keyed by the
 * unit that opened it. Written by whatever observed the forge — the poller, or
 * an operator confirming by hand — and read by the operator projections.
 */
export interface CohortPullRequestRepository {
  find(stage_instance_id: StageInstanceId, unit_id: UnitId): Promise<CohortPullRequestReconciliation | null>;
  upsert(reconciliation: CohortPullRequestReconciliation): Promise<void>;
}

export interface PersistFinalPullRequestObservation {
  readonly run_id: WorkflowRunId;
  readonly repository_key: string;
  readonly observation: PullRequestObservation;
  readonly updated_at: string;
}

export interface PersistFinalPullRequestConfirmation {
  readonly run_id: WorkflowRunId;
  readonly repository_key: string;
  readonly request: ConfirmFinalPullRequestRequest;
  readonly confirmed_at: string;
}

export interface FinalPullRequestRepository {
  observe(input: PersistFinalPullRequestObservation): Promise<Result<FinalPullRequestProjection, FinalPullRequestDomainError>>;
  confirm(input: PersistFinalPullRequestConfirmation): Promise<Result<FinalPullRequestProjection, FinalPullRequestDomainError>>;
}

export interface CollaborationRepository {
  insert_thread_with_message(thread: CollaborationThread, message: CollaborationMessage): Promise<{ readonly thread_id: ThreadId; readonly message_id: MessageId }>;
  insert_thread(thread: CollaborationThread): Promise<ThreadId>;
  insert_message(message: CollaborationMessage): Promise<MessageId>;
  insert_review_item(item: ReviewItem): Promise<ReviewItemId>;
  find_thread(id: ThreadId): Promise<CollaborationThread | null>;
  list_threads(chain_id: ArtifactId): Promise<readonly CollaborationThreadWithMessages[]>;
  update_thread_status(id: ThreadId, status: ThreadStatus): Promise<void>;
  find_review_item(id: ReviewItemId): Promise<ReviewItem | null>;
  list_review_items(chain_id: ArtifactId): Promise<readonly ReviewItem[]>;
  update_review_item(id: ReviewItemId, status: ReviewItemStatus, resolution: string | null): Promise<void>;
  count_open_review_items(revision_id: ArtifactId): Promise<number>;
}
