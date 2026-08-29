import { expect, test } from "bun:test";

import { selectRunDecision, selectStageDecision, selectUnitDecision } from "../src/domain/run-decisions";
import type { ArtifactRevision } from "../src/domain/artifacts";
import type { InputFingerprint, OutputSlotVersion, RunRecordVersion, RunUnitId, StageInstanceId, UnitId, WorkflowDefinitionId, WorkflowRunId, WorkOrderId } from "../src/domain/primitives";
import type { RunOutputSlot, RunStage, RunUnit, WorkflowRun, WorkOrder } from "../src/domain/run-record";

const runId = "11111111-1111-4111-8111-111111111111" as WorkflowRunId;
const stageId = "22222222-2222-4222-8222-222222222222" as StageInstanceId;
const runUnitId = "33333333-3333-4333-8333-333333333333" as RunUnitId;
const workOrderId = "44444444-4444-4444-8444-444444444444" as WorkOrderId;
const unitId = "unit-1" as UnitId;
const now = "2026-08-28T12:00:00.000Z";

const unit = (state: RunUnit["state"] = "working"): RunUnit => ({ id: runUnitId, run_id: runId, stage_instance_id: stageId, unit_id: unitId,
  parameters: {}, input_snapshot: [], input_fingerprint: "inputs" as InputFingerprint, state,
  outcome: state === "failed" ? { kind: "failed", code: "domain_failure", detail: "failed by policy" } : null,
  created_at: now, ended_at: state === "failed" ? now : null });
const order = (state: WorkOrder["state"]): WorkOrder => ({ id: workOrderId, run_unit_id: runUnitId, reason: "initial", input_snapshot: [],
  input_fingerprint: "inputs" as InputFingerprint, state, workflow_id: "work-order-1", request_idempotency_key: "initial", created_at: now,
  completed_at: state === "completed" || state === "abandoned" ? now : null });
const slot = (state: RunOutputSlot["state"]): RunOutputSlot => ({ run_unit_id: runUnitId, output_name: "result", artifact_type: "dev.result", required: true,
  state, updated_by_work_order_id: state.kind === "released" ? workOrderId : null, version: 1 as OutputSlotVersion });
const artifact: ArtifactRevision = { id: "55555555-5555-4555-8555-555555555555" as ArtifactRevision["id"], chain_id: "55555555-5555-4555-8555-555555555555" as ArtifactRevision["chain_id"],
  run_id: runId, stage_instance_id: stageId, execution_id: workOrderId as unknown as ArtifactRevision["execution_id"], unit_id: unitId,
  output_name: "result", artifact_type: "dev.result", label: unitId, body: { done: true }, version: 1, parent_artifact_id: null,
  lifecycle: { kind: "released", released_at: now }, created_at: now };

test("released run-owned slots satisfy a unit regardless of executor outcome", () => {
  const decision = selectUnitDecision({ unit: unit(), required_slots: [slot({ kind: "released", artifact_revision_id: artifact.id, released_at: now })],
    open_waits: [], work_orders: [order("started")], artifacts: [artifact] });
  expect(decision).toEqual({ kind: "satisfied", artifacts: [artifact] });
});

test("a child completion without its required slot does not satisfy the unit", () => {
  expect(selectUnitDecision({ unit: unit(), required_slots: [slot({ kind: "empty" })], open_waits: [], work_orders: [order("completed")], artifacts: [] }))
    .toEqual({ kind: "needs_work", missing_slots: [{ run_unit_id: runUnitId, output_name: "result" }] });
});

test("available business work is selected without consulting a child workflow", () => {
  expect(selectUnitDecision({ unit: unit("ready"), required_slots: [slot({ kind: "empty" })], open_waits: [], work_orders: [order("available")], artifacts: [] }))
    .toEqual({ kind: "work_available", work_order: order("available") });
});

test("stage and run completion are derived from stored unit decisions", () => {
  const stage: RunStage = { id: stageId, run_id: runId, stage_key: "build", contract: {}, state: "active", outcome: null,
    materialization_closed: true, created_at: now, ended_at: null };
  const stageDecision = selectStageDecision({ stage, units: [{ kind: "satisfied", artifacts: [artifact] }] });
  expect(stageDecision).toEqual({ kind: "succeeded" });
  const run: WorkflowRun = { id: runId, workflow_definition_id: "66666666-6666-4666-8666-666666666666" as WorkflowDefinitionId,
    workflow_definition_version: 1, context: {}, state: "active", outcome: null, record_version: 3 as RunRecordVersion, created_at: now, ended_at: null };
  expect(selectRunDecision({ run, stages: [stageDecision] })).toEqual({ kind: "complete", outcome: { kind: "succeeded" } });
});
