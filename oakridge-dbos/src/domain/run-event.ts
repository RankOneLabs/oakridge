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
type PullRequestRunEventOperation = "pull_request_observed" | "pull_request_merge_confirmed";
type OtherRunEventOperation = Exclude<RunTransitionOperation, GateRunEventOperation | PullRequestRunEventOperation>;

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

export type PullRequestRunEventDetail = {
  readonly [key: string]: JsonValue;
  readonly repository_key: string;
  readonly pull_request_url: string;
  readonly state: string;
  readonly source: string;
  readonly merged_at: string | null;
};

export interface PullRequestRunEventPayload extends RunEventPayload {
  readonly run_unit_id: RunUnitId;
  readonly stage_instance_id: StageInstanceId;
  readonly stage_key: StageKey;
  readonly unit_id: UnitId;
  readonly artifact_revision_id: ArtifactId;
  readonly detail: PullRequestRunEventDetail;
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
  | RunEventEnvelope<PullRequestRunEventOperation, PullRequestRunEventPayload>
  | RunEventEnvelope<OtherRunEventOperation, RunEventPayload>;

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

const isPullRequestOperation = (operation: RunTransitionOperation): operation is PullRequestRunEventOperation =>
  operation === "pull_request_observed" || operation === "pull_request_merge_confirmed";

const isJsonObject = (value: JsonValue): value is { readonly [key: string]: JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
  if (isPullRequestOperation(row.operation)) {
    const detail = payload.detail;
    if (!payload.run_unit_id || !payload.stage_instance_id || !payload.stage_key || !payload.unit_id || !payload.artifact_revision_id
        || !isJsonObject(detail) || typeof detail.repository_key !== "string" || typeof detail.pull_request_url !== "string"
        || typeof detail.state !== "string" || typeof detail.source !== "string"
        || !(detail.merged_at === null || typeof detail.merged_at === "string")) {
      throw new Error(`run event '${row.sequence}' has an invalid ${row.operation} payload`);
    }
    return { ...envelope, operation: row.operation, payload: { ...payload,
      run_unit_id: payload.run_unit_id, stage_instance_id: payload.stage_instance_id, stage_key: payload.stage_key,
      unit_id: payload.unit_id, artifact_revision_id: payload.artifact_revision_id,
      detail: { ...detail, repository_key: detail.repository_key, pull_request_url: detail.pull_request_url,
        state: detail.state, source: detail.source, merged_at: detail.merged_at } } };
  }
  return { ...envelope, operation: row.operation, payload };
};
