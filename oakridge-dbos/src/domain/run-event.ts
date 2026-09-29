import type { OutputAttention, OutputContinuation } from "./compiled-workflow";
import type { RunTransitionOperation } from "./run-record";
import type { ArtifactId, JsonValue, OutputCollectionKey, RunUnitId, StageInstanceId, UnitId, WorkflowRunId, WorkOrderId, WaitId } from "./primitives";
import type { StageKey } from "./workflow";

export interface RunEventPayload {
  readonly run_id: WorkflowRunId;
  readonly run_unit_id: RunUnitId | null;
  readonly stage_instance_id: StageInstanceId | null;
  readonly stage_key: StageKey | null;
  readonly unit_id: UnitId | null;
  readonly work_order_id: WorkOrderId | null;
  readonly wait_id: WaitId | null;
  readonly output_name: string | null;
  readonly collection_key: OutputCollectionKey | null;
  readonly artifact_revision_id: ArtifactId | null;
  readonly attention: OutputAttention | null;
  readonly continuation: OutputContinuation | null;
  readonly detail: JsonValue;
}

type GateRunEventOperation = "gate_opened" | "gate_decided";

export interface GateRunEventPayload extends RunEventPayload {
  readonly run_unit_id: RunUnitId;
  readonly stage_instance_id: StageInstanceId;
  readonly stage_key: StageKey;
  readonly unit_id: UnitId;
  readonly wait_id: WaitId;
  readonly output_name: string;
  readonly artifact_revision_id: ArtifactId;
  readonly attention: OutputAttention;
  readonly continuation: OutputContinuation;
}

interface RunEventEnvelope<Operation extends RunTransitionOperation, Payload extends RunEventPayload> {
  readonly sequence: string;
  readonly operation: Operation;
  readonly payload: Payload;
  readonly occurred_at: string;
}

/** Operations with stronger ledger invariants expose those invariants to consumers. */
export type RunEvent =
  | RunEventEnvelope<GateRunEventOperation, GateRunEventPayload>
  | RunEventEnvelope<RunTransitionOperation, RunEventPayload>;

export interface RunEventRow {
  readonly sequence: string;
  readonly operation: RunTransitionOperation;
  readonly run_id: string;
  readonly run_unit_id: string | null;
  readonly stage_instance_id: string | null;
  readonly stage_key: string | null;
  readonly unit_id: string | null;
  readonly work_order_id: string | null;
  readonly wait_id: string | null;
  readonly output_name: string | null;
  readonly collection_key: string | null;
  readonly artifact_revision_id: string | null;
  readonly attention: OutputAttention | null;
  readonly continuation: OutputContinuation | null;
  readonly detail: JsonValue;
  readonly created_at: string;
}

const isGateOperation = (operation: RunTransitionOperation): operation is GateRunEventOperation =>
  operation === "gate_opened" || operation === "gate_decided";

export const projectRunEvent = (row: RunEventRow): RunEvent => {
  const payload: RunEventPayload = {
    run_id: row.run_id as WorkflowRunId,
    run_unit_id: row.run_unit_id as RunUnitId | null,
    stage_instance_id: row.stage_instance_id as StageInstanceId | null,
    stage_key: row.stage_key,
    unit_id: row.unit_id as UnitId | null,
    work_order_id: row.work_order_id as WorkOrderId | null,
    wait_id: row.wait_id as WaitId | null,
    output_name: row.output_name,
    collection_key: row.collection_key as OutputCollectionKey | null,
    artifact_revision_id: row.artifact_revision_id as ArtifactId | null,
    attention: row.attention,
    continuation: row.continuation,
    detail: row.detail,
  };
  const envelope = { sequence: row.sequence, occurred_at: row.created_at };
  if (isGateOperation(row.operation)) {
    if (!payload.run_unit_id || !payload.stage_instance_id || !payload.stage_key || !payload.unit_id || !payload.wait_id
        || !payload.output_name || !payload.artifact_revision_id || !payload.attention || !payload.continuation) {
      throw new Error(`run event '${row.sequence}' has an invalid ${row.operation} payload`);
    }
    return { ...envelope, operation: row.operation, payload: { ...payload,
      run_unit_id: payload.run_unit_id, stage_instance_id: payload.stage_instance_id, stage_key: payload.stage_key,
      unit_id: payload.unit_id, wait_id: payload.wait_id, output_name: payload.output_name,
      artifact_revision_id: payload.artifact_revision_id, attention: payload.attention, continuation: payload.continuation } };
  }
  return { ...envelope, operation: row.operation, payload };
};
