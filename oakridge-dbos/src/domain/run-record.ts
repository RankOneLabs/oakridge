import type { ArtifactRevision } from "./artifacts";
import type { ArtifactEnvelope, ExecutorTerminalObservation, ExternalExecutionReference } from "./execution";
import type {
  ArtifactId,
  InputFingerprint,
  JsonValue,
  OutputSlotVersion,
  RunRecordVersion,
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
  readonly outcome: StageOutcome | null;
  readonly created_at: string;
  readonly ended_at: string | null;
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
  readonly output_name: string;
  readonly artifact_type: ArtifactTypeId;
  readonly required: boolean;
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
}

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

export interface PublishWorkOrderArtifact {
  readonly artifact_id: ArtifactId;
  readonly work_order_id: WorkOrderId;
  readonly capability_hash: string;
  readonly output_name: string;
  readonly body: JsonValue;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly published_at: string;
}

export type PublishWorkOrderArtifactResult =
  | { readonly kind: "published"; readonly artifact_id: ArtifactId; readonly record_version: RunRecordVersion }
  | { readonly kind: "already_applied"; readonly artifact_id: ArtifactId; readonly record_version: RunRecordVersion }
  | { readonly kind: "work_not_found" | "invalid_capability" | "work_abandoned" | "slot_not_found" | "slot_invalidated"; readonly detail: string }
  | { readonly kind: "slot_already_released"; readonly artifact_id: ArtifactId; readonly detail: string }
  | { readonly kind: "idempotency_conflict"; readonly artifact_id: ArtifactId; readonly detail: string };

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
