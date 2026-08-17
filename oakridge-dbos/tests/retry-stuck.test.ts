import { expect, test } from "bun:test";

import type { StageRerunState, UnitRerunTarget } from "../src/domain/rerun";
import type { StageInstanceId, UnitId, WorkflowDefinitionId, WorkflowRunId } from "../src/domain/primitives";
import type { WorkflowDefinition } from "../src/domain/workflow";
import { createRerunApp, type RerunHttpDependencies } from "../src/http/rerun";

const stageId = "11111111-1111-4111-8111-111111111111" as StageInstanceId;
const unitId = "web" as UnitId;
const runId = "22222222-2222-4222-8222-222222222222" as WorkflowRunId;
const stage = { id: stageId, run_id: runId, stage_key: "build", stage_type: "delegated_session", lifecycle: { kind: "started" as const, started_at: "2026-08-15T12:00:00Z" } };
const target: UnitRerunTarget = { run_id: runId, stage_instance_id: stageId, unit_id: unitId, execution_id: "execution-1" as UnitRerunTarget["execution_id"], execution_workflow_id: "root:stage:build:unit:web", stage_coordinator_workflow_id: "root:stage:build" };
const definition: WorkflowDefinition = { id: "33333333-3333-4333-8333-333333333333" as WorkflowDefinitionId, name: "flow", version: 1, archived: false, created_at: "2026-08-15T12:00:00Z", graph: { stages: { build: { stage_type: "delegated_session", operator_role: "build", config: {}, inputs: [], outputs: [] } }, edges: [] } };

const fixture = (state: StageRerunState | null = { status: "waiting", stage_instance_id: stageId, unit_id: unitId, failed_execution_workflow_id: target.execution_workflow_id, code: "executor_failed", detail: "failed" }) => {
  const forks: string[] = [];
  const started: string[] = [];
  const dependencies = {
    stages: { async find_by_id() { return stage; } },
    targets: { async find_unit_target() { return target; }, async replace_execution_workflow() {} },
    dbos: {
      async getEvent() { return state as never; }, async getWorkflow() { return undefined; },
      async forkWorkflow(_source: string, _step: number, options: { newWorkflowID: string }) { forks.push(options.newWorkflowID); return options.newWorkflowID; },
      async send() {},
    },
    stage_rerun: {
      runs: { async find_by_id() { return { id: runId, workflow_definition_id: definition.id, context: {}, archived: false }; } },
      definitions: { async find_by_id() { return definition; } },
      attempts: { async find_by_root_workflow_id() { return null; }, async list_for_run() { return [{ root_workflow_id: "root-1", run_id: runId, forked_from_root_workflow_id: null, created_at: "2026-08-15T12:00:00Z" }]; }, async insert() {} },
      dbos: { async start_run(workflowId: string) { started.push(workflowId); } }, now: () => "2026-08-15T12:30:00Z", supersede_attempt: async () => {},
    },
    cancellation: {},
  } as unknown as RerunHttpDependencies;
  return { app: createRerunApp(dependencies), dependencies, forks, started };
};

const retry = (app: ReturnType<typeof createRerunApp>, body: unknown) => app.request(`/stage_instances/${stageId}/retry_stuck`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("retry_stuck maps a unit to rerunUnit with a deterministic server-owned command identity", async () => {
  const first = fixture();
  const response = await retry(first.app, { unit_id: unitId });
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ kind: "accepted_unit", stage_instance_id: stageId, unit_id: unitId });
  expect(first.forks).toHaveLength(1);
  const second = fixture();
  await retry(second.app, { unit_id: unitId });
  expect(second.forks).toEqual(first.forks);
  expect(first.forks[0]).toMatch(/^oakridge-unit-rerun:11111111-1111-4111-8111-111111111111:web:[a-f0-9]{32}$/);
});

test("retry_stuck without a unit maps the persisted StageInstance to rerunStage", async () => {
  const subject = fixture();
  subject.dependencies.stages.find_by_id = async () => ({ ...stage, lifecycle: { kind: "finished", started_at: "2026-08-15T12:00:00Z", ended_at: "2026-08-15T12:15:00Z", outcome: { kind: "failed", code: "stuck_timeout", detail: "executor stopped" } } });
  const response = await retry(createRerunApp(subject.dependencies), {});
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ kind: "accepted_stage", stage_instance_id: stageId, unit_id: null });
  expect(subject.started).toHaveLength(1);
  expect(subject.started[0]).toMatch(/^oakridge-stage-rerun:22222222-2222-4222-8222-222222222222:build:[a-f0-9]{32}$/);
});

test("unitless retry_stuck rejects a running stage instead of creating arbitrary work", async () => {
  const subject = fixture();
  const response = await retry(subject.app, {});
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ kind: "not_stuck", stage_instance_id: stageId, unit_id: null, detail: "stage instance '11111111-1111-4111-8111-111111111111' is not terminal with a failed outcome" });
  expect(subject.started).toEqual([]);
});

test("retry_stuck returns a typed conflict when the unit is not durably waiting", async () => {
  const response = await retry(fixture(null).app, { unit_id: unitId });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ kind: "not_stuck", stage_instance_id: stageId, unit_id: unitId, detail: "execution unit '11111111-1111-4111-8111-111111111111:web' is not waiting for rerun" });
});

test("retry_stuck validates the optional unit_id body", async () => {
  const response = await retry(fixture().app, { unit_id: "" });
  expect(response.status).toBe(400);
});

test("retry_stuck returns typed missing-stage and missing-unit outcomes", async () => {
  const missingStage = fixture(); missingStage.dependencies.stages.find_by_id = async () => null;
  const stageResponse = await retry(createRerunApp(missingStage.dependencies), {});
  expect(stageResponse.status).toBe(404);
  expect(await stageResponse.json()).toEqual(expect.objectContaining({ kind: "stage_not_found", stage_instance_id: stageId }));

  const missingUnit = fixture(); missingUnit.dependencies.targets.find_unit_target = async () => null;
  const unitResponse = await retry(createRerunApp(missingUnit.dependencies), { unit_id: unitId });
  expect(unitResponse.status).toBe(404);
  expect(await unitResponse.json()).toEqual(expect.objectContaining({ kind: "unit_not_found", stage_instance_id: stageId, unit_id: unitId }));
});
