import type { ArtifactId, ExecutionId, JsonValue, StageInstanceId, UnitId, WorkflowDefinitionId, WorkflowRunId } from "../domain/primitives";
import type { StageInstance, StageOutcome, WorkflowDefinition } from "../domain/workflow";
import type { EpicWorkflowProfile, EpicWorkflowProfileId } from "../domain/epic";
import type { GateDecisionAudit, GateDecisionAuditId } from "../domain/gates";
import type { CollaborationMessage, CollaborationThread, CollaborationThreadWithMessages, MessageId, ReviewItem, ReviewItemId, ReviewItemStatus, ThreadId, ThreadStatus } from "../domain/collaboration";
import type { ArtifactEmission, ArtifactEmissionDelivery, ArtifactRevision, EmitArtifactRevisionResult, PendingArtifactNotification, ReleaseArtifactResult, WithdrawArtifactRequest, WithdrawArtifactResult } from "../domain/artifacts";
import type { CompiledOutputContract } from "../domain/compiled-workflow";
import type { ArtifactEnvelope } from "../domain/execution";
import type { ExecutionRequest, ExecutorTerminalObservation, ExternalExecutionReference } from "../domain/execution";
import type { CancellationExecutionTarget, CancellationWaitTarget, UnitRerunTarget } from "../domain/rerun";
import type { CreateProject, Project } from "../domain/projects";
import type { CreateWorkflowRunResult, DeleteRunResult, PendingRunLaunch, PersistWorkflowRunLaunch, SetRunArchiveResult, WorkflowRunLaunchRecord, WorkflowRunListFilter } from "../domain/runs";

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

export interface ArtifactRevisionRepository {
  emit_revision(id: ArtifactId, emission: ArtifactEmission, created_at: string, delivery: ArtifactEmissionDelivery): Promise<EmitArtifactRevisionResult>;
  withdraw(request: WithdrawArtifactRequest): Promise<WithdrawArtifactResult>;
  mark_released(id: ArtifactId, released_at: string): Promise<ReleaseArtifactResult>;
  find_tip(stage_instance_id: StageInstanceId, execution_id: string, unit_id: string, output_name: string): Promise<ArtifactRevision | null>;
  find_current(stage_instance_id: StageInstanceId, execution_id: string, unit_id: string, output_name: string): Promise<ArtifactRevision | null>;
  list_chain(chain_id: ArtifactId): Promise<readonly ArtifactRevision[]>;
  find_by_id(id: ArtifactId): Promise<ArtifactRevision | null>;
}

export interface RunArtifactReadRepository {
  list_effective_for_run(run_id: WorkflowRunId): Promise<readonly ArtifactRevision[]>;
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
}

export interface RerunTargetRepository {
  find_unit_target(stage_instance_id: StageInstanceId, unit_id: UnitId): Promise<UnitRerunTarget | null>;
  replace_execution_workflow(execution_id: ExecutionId, replacement_workflow_id: string): Promise<void>;
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
