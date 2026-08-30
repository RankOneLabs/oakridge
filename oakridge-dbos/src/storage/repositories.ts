import type { ArtifactId, JsonValue, StageInstanceId, UnitId, WorkflowDefinitionId, WorkflowRunId } from "../domain/primitives";
import type { StageInstance, WorkflowDefinition } from "../domain/workflow";
import type { EpicWorkflowProfile, EpicWorkflowProfileId } from "../domain/epic";
import type { GateDecisionAudit, GateDecisionAuditId } from "../domain/gates";
import type { CollaborationMessage, CollaborationThread, CollaborationThreadWithMessages, MessageId, ReviewItem, ReviewItemId, ReviewItemStatus, ThreadId, ThreadStatus } from "../domain/collaboration";
import type { ArtifactCoordinate, ArtifactRevision } from "../domain/artifacts";
import type { SessionHold } from "../domain/session-hold";
import type { CreateProject, Project } from "../domain/projects";
import type { AdmitStageUnitRequest, AdmitStageUnitResult, CreateWorkflowRunResult, DeleteRunResult, PersistWorkflowRunLaunch, SetRunArchiveResult, UnstartedRun, WorkflowRunLaunchRecord, WorkflowRunListFilter } from "../domain/runs";
import type { ConfirmFinalPullRequestRequest, FinalPullRequestDomainError, FinalPullRequestProjection, PullRequestObservation } from "../domain/final-pull-request";
import type { CohortPullRequestReconciliation, RunOwnedCohortHandoff } from "../domain/cohort-pull-request";
import type { ExternalExecutionReference } from "../domain/execution";
import type { Result } from "../domain/primitives";
import type { CancelRunRecord, CancelRunRecordResult, CloseRunOutputWait, CloseRunOutputWaitResult, CompleteHandoffArtifact, DecideGateWait, ExecutorAttachment, ExecutorHealthObservation, InitializeStraightThroughRun, PersistMaterializedStage, PublishWorkOrderArtifact, PublishWorkOrderArtifactResult, RetryRunUnit, RetryRunUnitResult, ReviseRunUnitInput, ReviseRunUnitInputResult, WorkOrderExecution } from "../domain/run-record";
import type { AskResult } from "../decision/commands";
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
  find_by_id(id: WorkflowRunId): Promise<WorkflowRunRecord | null>;
  create_run(input: PersistWorkflowRunLaunch): Promise<CreateWorkflowRunResult>;
  find_launch_by_id(id: WorkflowRunId): Promise<WorkflowRunLaunchRecord | null>;
  list(filter?: WorkflowRunListFilter): Promise<readonly WorkflowRunLaunchRecord[]>;
  set_archived(id: WorkflowRunId, archived: boolean): Promise<SetRunArchiveResult>;
  /** An `active` run with no `dbos.workflow_status` row for its derived root workflow id — the sweep's launch candidates. */
  list_unstarted_runs(limit: number): Promise<readonly UnstartedRun[]>;
}

/** The single transactional boundary workflows ask for v2 run truth. */
export interface RunRecordRepository {
  initialize_straight_through(input: InitializeStraightThroughRun): Promise<void>;
  persist_materialized_stage(input: PersistMaterializedStage): Promise<void>;
  revise_unit_input(input: ReviseRunUnitInput): Promise<ReviseRunUnitInputResult>;
  retry_unit(input: RetryRunUnit, retried_at: string): Promise<RetryRunUnitResult>;
  admit_unit(request: AdmitStageUnitRequest, admitted_at: string): Promise<AdmitStageUnitResult>;
  decide_run(run_id: RunRecordWorkflowRunId, decided_at: string): Promise<Result<AskResult, RunRecordRepositoryError>>;
  load_work_order_capability_seed(): Promise<string>;
  cancel_run(input: CancelRunRecord): Promise<CancelRunRecordResult>;
  delete_run(run_id: RunRecordWorkflowRunId): Promise<DeleteRunResult>;
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
  decide_gate_wait(request: DecideGateWait): Promise<CloseRunOutputWaitResult>;
  complete_handoff_artifact(request: CompleteHandoffArtifact): Promise<CloseRunOutputWaitResult>;
  find_cohort_handoff(stage_instance_id: StageInstanceId, unit_id: UnitId): Promise<RunOwnedCohortHandoff | null>;
  ensure_executor_attachment(work_order_id: WorkOrderId, executor_type: string, updated_at: string): Promise<ExecutorAttachment>;
  attach_external(work_order_id: WorkOrderId, reference: ExternalExecutionReference, updated_at: string): Promise<void>;
  observe_executor(work_order_id: WorkOrderId, health: ExecutorHealthObservation, updated_at: string): Promise<void>;
  request_cleanup(work_order_id: WorkOrderId, updated_at: string): Promise<void>;
  finish_cleanup(work_order_id: WorkOrderId, succeeded: boolean, updated_at: string): Promise<void>;
}

export interface RunRecordRepositoryError {
  readonly operation: "decide_run";
  readonly run_id: RunRecordWorkflowRunId;
  readonly kind: "run_not_found";
  readonly detail: string;
}

export interface StageInstanceRepository {
  find_by_id(id: StageInstanceId): Promise<StageInstance | null>;
}

export interface ArtifactRevisionRepository {
  find_current(coordinate: ArtifactCoordinate): Promise<ArtifactRevision | null>;
  list_chain(chain_id: ArtifactId): Promise<readonly ArtifactRevision[]>;
  find_by_id(id: ArtifactId): Promise<ArtifactRevision | null>;
}

export interface RunArtifactReadRepository {
  list_effective_for_run(run_id: WorkflowRunId): Promise<readonly ArtifactRevision[]>;
}

export interface SessionHoldRepository {
  /** The live execution holding this agent session, if any. */
  find_session_hold(session_id: string): Promise<SessionHold | null>;
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
