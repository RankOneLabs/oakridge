/**
 * The ids `derive` mints — spec §13, moved verbatim from
 * `runtime/run-materialization.ts`. Determinism here is what makes replay
 * and duplicate-ask safety free: never introduce a random id anywhere in
 * the decision path.
 */
import { createHash } from "node:crypto";

import type { InputFingerprint, RunUnitId, StageInstanceId, UnitId, WorkflowRunId, WorkOrderId } from "../domain/primitives";
import type { StageKey } from "../domain/workflow";

const stableUuid = (identity: string): string => {
  const hex = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
};

export const stageInstanceIdFor = (run_id: WorkflowRunId, stage_key: StageKey): StageInstanceId =>
  stableUuid(`${run_id}:stage:${stage_key}`) as StageInstanceId;

export const runUnitIdFor = (run_id: WorkflowRunId, stage_key: StageKey, unit_id: UnitId): RunUnitId =>
  stableUuid(`${run_id}:${stage_key}:unit:${unit_id}`) as RunUnitId;

/** `identity` is `"initial"` or `"revision:<fingerprint>"`. */
export const workOrderIdFor = (run_id: WorkflowRunId, stage_key: StageKey, unit_id: UnitId, identity: string): WorkOrderId =>
  stableUuid(`${run_id}:${stage_key}:${unit_id}:${identity}`) as WorkOrderId;

export const workOrderWorkflowId = (work_order_id: WorkOrderId): string => `v2-work:${work_order_id}`;

export const fingerprintOf = (value: unknown): InputFingerprint => createHash("sha256").update(JSON.stringify(value)).digest("hex") as InputFingerprint;
