import { expect, test } from "bun:test";

import type { StageRerunState, UnitRerunTarget } from "../src/domain/rerun";
import type { StageInstanceId, UnitId } from "../src/domain/primitives";
import { rerunUnit, type RerunDbosClient } from "../src/runtime/unit-rerun";
import type { RerunTargetRepository } from "../src/storage/repositories";

const stageId = "stage-1" as StageInstanceId;
const unitId = "web" as UnitId;
const target: UnitRerunTarget = { run_id: "run-1" as UnitRerunTarget["run_id"], stage_instance_id: stageId, unit_id: unitId,
  execution_id: "execution-1" as UnitRerunTarget["execution_id"], execution_workflow_id: "root:stage:build:unit:web", stage_coordinator_workflow_id: "root:stage:build" };

test("unit rerun forks only the failed execution child and returns it to the durable stage owner", async () => {
  const calls: string[] = [];
  const repository: RerunTargetRepository = {
    async find_unit_target() { return target; },
    async replace_execution_workflow(_executionId, workflowId) { calls.push(`project:${workflowId}`); },
  };
  const waiting: StageRerunState = { status: "waiting", stage_instance_id: stageId, unit_id: unitId,
    failed_execution_workflow_id: target.execution_workflow_id, code: "executor_failed", detail: "failed" };
  const dbos: RerunDbosClient = {
    async getEvent() { return waiting as never; },
    async getWorkflow() { return undefined; },
    async forkWorkflow(workflowId, startStep, options) { calls.push(`fork:${workflowId}:${startStep}:${options.newWorkflowID}`); return options.newWorkflowID; },
    async send(destinationId, message) { calls.push(`send:${destinationId}:${(message as { kind: string }).kind}`); },
  };
  const result = await rerunUnit({ stage_instance_id: stageId, unit_id: unitId, rerun_id: "operator-command-1" }, repository, dbos);
  expect(result.replacement_execution_workflow_id).toBe("oakridge-unit-rerun:stage-1:web:operator-command-1");
  expect(calls).toEqual([
    "fork:root:stage:build:unit:web:0:oakridge-unit-rerun:stage-1:web:operator-command-1",
    "send:root:stage:build:replace_execution",
  ]);
  expect(calls.some((call) => call.startsWith("project:"))).toBe(false);
});

test("unit rerun retry returns the same replacement after the stage has resumed", async () => {
  const replacement = "oakridge-unit-rerun:stage-1:web:operator-command-1";
  const resumedTarget = { ...target, execution_workflow_id: replacement };
  const repository: RerunTargetRepository = { async find_unit_target() { return resumedTarget; }, async replace_execution_workflow() { throw new Error("must not project twice"); } };
  const resumed: StageRerunState = { status: "resumed", stage_instance_id: stageId, unit_id: unitId,
    replacement_execution_workflow_id: replacement };
  const dbos: RerunDbosClient = { async getEvent() { return resumed as never; }, async getWorkflow() { throw new Error("must not inspect"); },
    async forkWorkflow() { throw new Error("must not fork"); }, async send() { throw new Error("must not send"); } };
  expect(await rerunUnit({ stage_instance_id: stageId, unit_id: unitId, rerun_id: "operator-command-1" }, repository, dbos))
    .toEqual({ replacement_execution_workflow_id: replacement });
});

test("unit rerun refuses to infer a target unless the owning stage is durably waiting for that exact child", async () => {
  const repository: RerunTargetRepository = { async find_unit_target() { return target; }, async replace_execution_workflow() {} };
  const dbos: RerunDbosClient = { async getEvent() { return null; }, async getWorkflow() { return undefined; },
    async forkWorkflow() { throw new Error("must not fork"); }, async send() { throw new Error("must not send"); } };
  expect(rerunUnit({ stage_instance_id: stageId, unit_id: unitId, rerun_id: "operator-command-1" }, repository, dbos)).rejects.toThrow("not waiting for rerun");
});

test("unit rerun retry after send but before stage consumption reuses the fork and command identity", async () => {
  const replacement = "oakridge-unit-rerun:stage-1:web:operator-command-1";
  const calls: string[] = [];
  const repository: RerunTargetRepository = { async find_unit_target() { return target; }, async replace_execution_workflow() { throw new Error("HTTP path must not project"); } };
  const waiting: StageRerunState = { status: "waiting", stage_instance_id: stageId, unit_id: unitId,
    failed_execution_workflow_id: target.execution_workflow_id, code: "executor_failed", detail: "failed" };
  const dbos: RerunDbosClient = {
    async getEvent() { return waiting as never; }, async getWorkflow() { return { workflowID: replacement, forkedFrom: target.execution_workflow_id }; },
    async forkWorkflow() { throw new Error("must reuse the existing fork"); },
    async send(_destination, _message, _topic, key) { calls.push(key ?? "missing"); },
  };
  await rerunUnit({ stage_instance_id: stageId, unit_id: unitId, rerun_id: "operator-command-1" }, repository, dbos);
  await rerunUnit({ stage_instance_id: stageId, unit_id: unitId, rerun_id: "operator-command-1" }, repository, dbos);
  expect(calls).toEqual(["rerun:operator-command-1", "rerun:operator-command-1"]);
});

test("unit rerun retry converges after the stage projected replacement but before it acknowledged resume", async () => {
  const replacement = "oakridge-unit-rerun:stage-1:web:operator-command-1";
  const projected = { ...target, execution_workflow_id: replacement };
  const repository: RerunTargetRepository = { async find_unit_target() { return projected; }, async replace_execution_workflow() { throw new Error("HTTP path must not project"); } };
  const waiting: StageRerunState = { status: "waiting", stage_instance_id: stageId, unit_id: unitId,
    failed_execution_workflow_id: target.execution_workflow_id, code: "executor_failed", detail: "failed" };
  const dbos: RerunDbosClient = {
    async getEvent() { return waiting as never; }, async getWorkflow() { return { workflowID: replacement, forkedFrom: target.execution_workflow_id }; },
    async forkWorkflow() { throw new Error("must not fork"); }, async send() { throw new Error("must not resend after projection"); },
  };
  expect(await rerunUnit({ stage_instance_id: stageId, unit_id: unitId, rerun_id: "operator-command-1" }, repository, dbos))
    .toEqual({ replacement_execution_workflow_id: replacement });
});
