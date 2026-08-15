import type { ArtifactId, ExecutionId, JsonValue, StageInstanceId, UnitId, WorkflowDefinitionId, WorkflowRunId } from "../domain/primitives";
import type { StageInstance, StageOutcome, WorkflowDefinition } from "../domain/workflow";
import type { EpicWorkflowProfile, EpicWorkflowProfileId } from "../domain/epic";
import type { GateDecisionAudit, GateDecisionAuditId } from "../domain/gates";
import type { CollaborationMessage, CollaborationThread, CollaborationThreadWithMessages, MessageId, ReviewItem, ReviewItemId, ReviewItemStatus, ThreadId, ThreadStatus } from "../domain/collaboration";
import type { ArtifactEmission, ArtifactRevision } from "../domain/artifacts";
import type { CompiledOutputContract } from "../domain/compiled-workflow";
import type { ArtifactEnvelope } from "../domain/execution";
import type { ExecutionRequest, ExecutorTerminalObservation, ExternalExecutionReference } from "../domain/execution";
import type { CancellationExecutionTarget, UnitRerunTarget } from "../domain/rerun";

export interface WorkflowDefinitionRepository {
  insert_immutable(definition: WorkflowDefinition): Promise<WorkflowDefinition>;
  find_by_id(id: WorkflowDefinitionId): Promise<WorkflowDefinition | null>;
  find_by_name_version(name: string, version: number): Promise<WorkflowDefinition | null>;
  list(): Promise<readonly WorkflowDefinition[]>;
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

export interface InsertArtifact {
  readonly id: ArtifactId;
  readonly run_id: WorkflowRunId;
  readonly stage_instance_id: StageInstanceId;
  readonly execution_id: string;
  readonly unit_id: string;
  readonly output_name: string;
  readonly artifact_type: string;
  readonly body: JsonValue;
  readonly emission_idempotency_key: string;
  readonly emission_payload_hash: string;
}

export interface ArtifactRepository {
  insert_idempotent(input: InsertArtifact): Promise<ArtifactId>;
}

export interface ArtifactRevisionRepository {
  emit_revision(id: ArtifactId, emission: ArtifactEmission, created_at: string): Promise<ArtifactRevision>;
  find_tip(stage_instance_id: StageInstanceId, execution_id: string, unit_id: string, output_name: string): Promise<ArtifactRevision | null>;
  list_chain(chain_id: ArtifactId): Promise<readonly ArtifactRevision[]>;
  find_by_id(id: ArtifactId): Promise<ArtifactRevision | null>;
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
