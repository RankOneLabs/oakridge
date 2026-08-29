import type { ArtifactRevision } from "./artifacts";
import type { OutputReleaseContract } from "./compiled-workflow";
import type { ArtifactEnvelope, ExecutorTerminalObservation, ExternalExecutionReference } from "./execution";
import type {
  ArtifactId,
  InputFingerprint,
  JsonValue,
  OutputSlotVersion,
  OutputCollectionKey,
  RunRecordVersion,
  RunTransitionId,
  RunUnitId,
  StageInstanceId,
  UnitId,
  WaitId,
  WorkflowDefinitionId,
  WorkflowRunId,
  WorkOrderId,
} from "./primitives";
import type { Wait } from "./wait";
import type { ArtifactTypeId, StageKey, StageOutcome } from "./workflow";

export type RunState = "active" | "succeeded" | "failed" | "cancelled";
export type UnitState = "ready" | "working" | "waiting" | "satisfied" | "failed" | "cancelled";
export type WorkOrderState = "available" | "started" | "completed" | "abandoned";
export type WorkOrderReason = "initial" | "operator_retry" | "input_revision";

export interface WorkflowRun {
  readonly id: WorkflowRunId;
  readonly workflow_definition_id: WorkflowDefinitionId;
  readonly workflow_definition_version: number;
  readonly context: JsonValue;
  readonly state: RunState;
  readonly outcome: StageOutcome | null;
  readonly record_version: RunRecordVersion;
  readonly created_at: string;
  readonly ended_at: string | null;
}

export interface RunStage {
  readonly id: StageInstanceId;
  readonly run_id: WorkflowRunId;
  readonly stage_key: StageKey;
  readonly contract: JsonValue;
  readonly state: RunState;
  readonly outcome: StageOutcome | null;
  readonly materialization_closed: boolean;
  readonly created_at: string;
  readonly ended_at: string | null;
}

export interface RunUnit {
  readonly id: RunUnitId;
  readonly run_id: WorkflowRunId;
  readonly stage_instance_id: StageInstanceId;
  readonly unit_id: UnitId;
  readonly parameters: JsonValue;
  readonly input_snapshot: readonly ArtifactEnvelope[];
  readonly input_fingerprint: InputFingerprint;
  readonly state: UnitState;
  readonly admitted: boolean;
  readonly admitted_at: string | null;
  readonly outcome: StageOutcome | null;
  readonly created_at: string;
  readonly ended_at: string | null;
}

export type OutputSlotIdentity =
  | { readonly kind: "scalar"; readonly output_name: string }
  | { readonly kind: "collection_member"; readonly output_name: string; readonly collection_key: OutputCollectionKey };

export interface RunUnitDependency {
  readonly stage_instance_id: StageInstanceId;
  readonly unit_id: UnitId;
  readonly depends_on_unit_id: UnitId;
}

export interface RunStageSchedulingPolicy {
  readonly stage_instance_id: StageInstanceId;
  readonly max_parallel: number;
  readonly manual_admission: boolean;
}

export type OutputInvalidationReason =
  | { readonly kind: "input_revision"; readonly input_fingerprint: InputFingerprint }
  | { readonly kind: "operator"; readonly detail: string };

export type RunOutputSlotState =
  | { readonly kind: "empty" }
  | { readonly kind: "pending"; readonly artifact_revision_id: ArtifactId; readonly release_wait_id: WaitId; readonly pending_at: string }
  | { readonly kind: "released"; readonly artifact_revision_id: ArtifactId; readonly released_at: string }
  | { readonly kind: "invalidated"; readonly previous_artifact_revision_id: ArtifactId | null; readonly reason: OutputInvalidationReason; readonly invalidated_at: string };

export interface RunOutputSlot {
  readonly run_unit_id: RunUnitId;
  readonly identity: OutputSlotIdentity;
  readonly output_name: string;
  readonly artifact_type: ArtifactTypeId;
  readonly required: boolean;
  /** Declared at unit creation; decides whether publication releases the slot directly or parks it pending a wait. */
  readonly release: OutputReleaseContract;
  readonly state: RunOutputSlotState;
  readonly updated_by_work_order_id: WorkOrderId | null;
  readonly version: OutputSlotVersion;
}

export interface WorkOrder {
  readonly id: WorkOrderId;
  readonly run_unit_id: RunUnitId;
  readonly reason: WorkOrderReason;
  readonly input_snapshot: readonly ArtifactEnvelope[];
  readonly input_fingerprint: InputFingerprint;
  readonly state: WorkOrderState;
  readonly workflow_id: string;
  readonly request_idempotency_key: string;
  readonly created_at: string;
  readonly completed_at: string | null;
}

export type ExecutorHealthObservation =
  | { readonly kind: "running"; readonly observed_at: string }
  | { readonly kind: "unresponsive"; readonly detail: string; readonly observed_at: string }
  | { readonly kind: "ended_succeeded"; readonly metadata: JsonValue; readonly observed_at: string }
  | { readonly kind: "ended_failed"; readonly code: string; readonly detail: string; readonly observed_at: string }
  | { readonly kind: "ended_cancelled"; readonly detail: string | null; readonly observed_at: string };

export interface ExecutorAttachment {
  readonly work_order_id: WorkOrderId;
  readonly executor_type: string;
  readonly external_reference: ExternalExecutionReference | null;
  readonly health: ExecutorHealthObservation | null;
  readonly cleanup_state: "not_needed" | "requested" | "complete" | "failed";
  readonly updated_at: string;
}

export interface StraightThroughOutput {
  readonly name: string;
  readonly artifact_type: ArtifactTypeId;
  readonly required: boolean;
  readonly release: OutputReleaseContract;
}

export interface MaterializedRunOutput {
  readonly identity: OutputSlotIdentity;
  readonly artifact_type: ArtifactTypeId;
  readonly required: boolean;
  readonly release: OutputReleaseContract;
}

export interface MaterializedWorkOrder {
  readonly id: WorkOrderId;
  readonly workflow_id: string;
  readonly capability_hash: string;
  readonly request: import("./execution").ExecutionRequest;
}

export interface MaterializedRunUnit {
  readonly id: RunUnitId;
  readonly unit_id: UnitId;
  readonly parameters: JsonValue;
  readonly input_snapshot: readonly ArtifactEnvelope[];
  readonly input_fingerprint: InputFingerprint;
  readonly depends_on: readonly UnitId[];
  readonly outputs: readonly MaterializedRunOutput[];
  readonly initial_work_order: MaterializedWorkOrder;
}

export interface PersistMaterializedStage {
  readonly run_id: WorkflowRunId;
  readonly stage_instance_id: StageInstanceId;
  readonly stage_key: StageKey;
  readonly stage_type: string;
  readonly stage_contract: JsonValue;
  readonly units: readonly MaterializedRunUnit[];
  readonly policy: Omit<RunStageSchedulingPolicy, "stage_instance_id">;
  readonly close_materialization: boolean;
  readonly materialized_at: string;
}

export interface ReviseRunUnitInput {
  readonly run_unit_id: RunUnitId;
  readonly input_snapshot: readonly ArtifactEnvelope[];
  readonly input_fingerprint: InputFingerprint;
  readonly revised_at: string;
  readonly actor: string;
  readonly replacement_work_order: MaterializedWorkOrder;
}

export interface RetryRunUnit {
  readonly run_unit_id: RunUnitId;
  readonly idempotency_key: string;
  readonly actor: string;
}

export type RetryRunUnitResult =
  | { readonly kind: "created" | "already_created"; readonly work_order: WorkOrder; readonly run_id: WorkflowRunId; readonly record_version: RunRecordVersion }
  | { readonly kind: "unit_not_found"; readonly detail: string }
  | { readonly kind: "not_active"; readonly detail: string }
  | { readonly kind: "work_in_progress"; readonly detail: string }
  | { readonly kind: "no_missing_work"; readonly detail: string }
  | { readonly kind: "actionable_wait"; readonly detail: string }
  | { readonly kind: "no_execution_basis"; readonly detail: string };

export type ReviseRunUnitInputResult =
  | { readonly kind: "revised"; readonly run_id: WorkflowRunId; readonly record_version: RunRecordVersion }
  | { readonly kind: "unchanged"; readonly run_id: WorkflowRunId; readonly record_version: RunRecordVersion }
  | { readonly kind: "unit_not_found"; readonly detail: string };

export interface InitializeStraightThroughRun {
  readonly run_id: WorkflowRunId;
  readonly stage_instance_id: StageInstanceId;
  readonly run_unit_id: RunUnitId;
  readonly unit_id: UnitId;
  readonly work_order_id: WorkOrderId;
  readonly work_order_workflow_id: string;
  /** SHA-256 of the secret given only to this work order's executor. */
  readonly work_order_capability_hash: string;
  readonly stage_key: StageKey;
  readonly executor_type: string;
  readonly resolved_config: JsonValue;
  readonly parameters: JsonValue;
  readonly input_snapshot: readonly ArtifactEnvelope[];
  readonly input_fingerprint: InputFingerprint;
  readonly outputs: readonly StraightThroughOutput[];
  readonly created_at: string;
}

export interface WorkOrderExecution {
  readonly work_order: WorkOrder;
  readonly request: import("./execution").ExecutionRequest;
}

/** The persisted facts the compiler asks when reconciling a run's materialized graph. */
export interface RunMaterializationUnitRecord {
  readonly id: RunUnitId;
  readonly unit_id: UnitId;
  readonly input_fingerprint: InputFingerprint;
  readonly state: UnitState;
}

export interface RunMaterializationStageRecord {
  readonly id: StageInstanceId;
  readonly stage_key: StageKey;
  readonly state: RunState;
  readonly materialization_closed: boolean;
  readonly units: readonly RunMaterializationUnitRecord[];
}

export interface RunMaterializationArtifact extends ArtifactEnvelope {
  readonly producer_stage_key: StageKey;
}

export interface RunMaterializationRecord {
  readonly run: WorkflowRun;
  readonly stages: readonly RunMaterializationStageRecord[];
  /** Released slots, plus pending handoffs whose policy makes them available downstream before external settlement. */
  readonly available_artifacts: readonly RunMaterializationArtifact[];
}

export interface FailRunMaterialization {
  readonly run_id: WorkflowRunId;
  readonly stage_key: StageKey | null;
  readonly detail: string;
  readonly failed_at: string;
}

export interface PublishWorkOrderArtifact {
  readonly artifact_id: ArtifactId;
  readonly work_order_id: WorkOrderId;
  readonly capability_hash: string;
  readonly output_name: string;
  readonly collection_key?: OutputCollectionKey | null;
  readonly body: JsonValue;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly published_at: string;
}

export type PublishWorkOrderArtifactResult =
  | { readonly kind: "published"; readonly artifact_id: ArtifactId; readonly run_id: WorkflowRunId; readonly record_version: RunRecordVersion }
  /** A gated or handoff release policy: the artifact is recorded and its slot parked pending the opened wait's decision. */
  | { readonly kind: "pending"; readonly artifact_id: ArtifactId; readonly wait_id: WaitId; readonly run_id: WorkflowRunId; readonly record_version: RunRecordVersion }
  | { readonly kind: "already_applied"; readonly artifact_id: ArtifactId; readonly run_id: WorkflowRunId; readonly record_version: RunRecordVersion }
  | { readonly kind: "work_not_found" | "invalid_capability" | "work_abandoned" | "slot_not_found" | "slot_invalidated"; readonly detail: string }
  | { readonly kind: "slot_already_released"; readonly artifact_id: ArtifactId; readonly detail: string }
  /** A different, non-replay publish arrived while the slot is already parked pending an earlier one's wait. */
  | { readonly kind: "slot_pending"; readonly wait_id: WaitId; readonly detail: string }
  | { readonly kind: "idempotency_conflict"; readonly artifact_id: ArtifactId; readonly detail: string };

/** What the gate/handoff command that owns a pending slot's wait decided. */
export type RunOutputWaitDisposition = "release" | "invalidate";

export interface CloseRunOutputWait {
  readonly wait_id: WaitId;
  readonly disposition: RunOutputWaitDisposition;
  /** Who or what made the decision — an operator identity or an external correlation id, recorded on the transition. */
  readonly actor: string;
  readonly detail: string | null;
  readonly decided_at: string;
}

export type CloseRunOutputWaitResult =
  | { readonly kind: "released"; readonly artifact_id: ArtifactId; readonly run_id: WorkflowRunId; readonly record_version: RunRecordVersion }
  | { readonly kind: "invalidated"; readonly run_id: WorkflowRunId; readonly record_version: RunRecordVersion }
  | { readonly kind: "already_applied"; readonly run_id: WorkflowRunId; readonly record_version: RunRecordVersion }
  | { readonly kind: "wait_not_found"; readonly detail: string }
  | { readonly kind: "wait_conflict"; readonly detail: string };

/**
 * One committed fact about a run-owned record changing, carrying the exact
 * record-version boundary it crossed. This is what an operator or recovery
 * path reads instead of inferring history from executor observations or DBOS
 * event payloads.
 */
export type RunTransitionOperation =
  | "stage_materialized"
  | "materialization_closed"
  | "materialization_failed"
  | "unit_admitted"
  | "operator_retry_created"
  | "input_revised"
  | "slot_released"
  | "slot_pending"
  | "slot_invalidated"
  | "unit_satisfied"
  | "work_started";

export interface RunTransition {
  readonly id: RunTransitionId;
  readonly run_id: WorkflowRunId;
  readonly run_unit_id: RunUnitId | null;
  readonly work_order_id: WorkOrderId | null;
  readonly wait_id: WaitId | null;
  readonly output_name: string | null;
  readonly collection_key: OutputCollectionKey | null;
  readonly operation: RunTransitionOperation;
  readonly actor: string;
  readonly prior_record_version: RunRecordVersion;
  readonly resulting_record_version: RunRecordVersion;
  readonly detail: JsonValue;
  readonly created_at: string;
}

export interface UnitOutcomeRecord {
  readonly unit: RunUnit;
  readonly required_slots: readonly RunOutputSlot[];
  readonly open_waits: readonly Wait[];
  readonly work_orders: readonly WorkOrder[];
  readonly artifacts: readonly ArtifactRevision[];
}

export type UnitDecision =
  | { readonly kind: "satisfied"; readonly artifacts: readonly ArtifactRevision[] }
  | { readonly kind: "waiting"; readonly waits: readonly Wait[] }
  | { readonly kind: "work_available"; readonly work_order: WorkOrder }
  | { readonly kind: "work_in_progress"; readonly work_order: WorkOrder }
  | { readonly kind: "needs_work"; readonly missing_slots: readonly Pick<RunOutputSlot, "run_unit_id" | "output_name">[] }
  | { readonly kind: "failed"; readonly outcome: Extract<StageOutcome, { readonly kind: "failed" }> }
  | { readonly kind: "cancelled"; readonly outcome: Extract<StageOutcome, { readonly kind: "cancelled" }> };

export interface StageDecisionRecord {
  readonly stage: RunStage;
  readonly units: readonly UnitDecision[];
}

export type StageDecision =
  | { readonly kind: "start_work"; readonly work_orders: readonly WorkOrder[] }
  | { readonly kind: "waiting" }
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly outcome: Extract<StageOutcome, { readonly kind: "failed" }> }
  | { readonly kind: "cancelled"; readonly outcome: Extract<StageOutcome, { readonly kind: "cancelled" }> };

export interface RunDecisionRecord {
  readonly run: WorkflowRun;
  readonly stages: readonly StageDecision[];
}

export type RunDecision =
  | { readonly kind: "start_work"; readonly work_orders: readonly WorkOrder[]; readonly record_version: RunRecordVersion }
  | { readonly kind: "wait"; readonly record_version: RunRecordVersion }
  | { readonly kind: "complete"; readonly outcome: StageOutcome };

export const executorHealthFromTerminal = (observation: ExecutorTerminalObservation, observed_at: string): ExecutorHealthObservation => {
  if (observation.kind === "succeeded") return { kind: "ended_succeeded", metadata: observation.metadata, observed_at };
  if (observation.kind === "failed") return { kind: "ended_failed", code: observation.code, detail: observation.detail, observed_at };
  return { kind: "ended_cancelled", detail: observation.detail, observed_at };
};
