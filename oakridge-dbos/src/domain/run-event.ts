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

/** One variant per ledger operation; `operation` narrows the event at consumers. */
export type RunEvent = {
  readonly [Operation in RunTransitionOperation]: {
    readonly sequence: string;
    readonly operation: Operation;
    readonly payload: RunEventPayload;
    readonly occurred_at: string;
  }
}[RunTransitionOperation];

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

export const projectRunEvent = (row: RunEventRow): RunEvent => ({
  sequence: row.sequence,
  operation: row.operation,
  payload: {
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
  },
  occurred_at: row.created_at,
} as RunEvent);
