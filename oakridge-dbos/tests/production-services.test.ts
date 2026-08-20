import { expect, test } from "bun:test";
import { createProductionTopologyServices } from "../src/runtime/production-services";
import { loadDevFlowV13 } from "../src/seed/dev-flow-v13";
import type { StageInstanceRepository, ExecutionProjectionRepository, WorkflowAttemptRepository, WorkflowDefinitionRepository, WorkflowRunRepository } from "../src/storage/repositories";

test("production services load and compile the immutable requested definition version", async () => {
  const loaded = await loadDevFlowV13();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const definition = loaded.value;
  const definitions = { find_by_id: async () => definition } as unknown as WorkflowDefinitionRepository;
  const services = createProductionTopologyServices({ definitions, runs: {} as WorkflowRunRepository, attempts: {} as WorkflowAttemptRepository,
    stages: {} as StageInstanceRepository, executions: {} as ExecutionProjectionRepository,
    rerun_targets: { async replace_execution_workflow() {}, async find_unit_target() { return null; } },
    resume_artifacts: { async list_latest_for_stages() { return []; } }, load_prompt_template: async () => "template" });
  const compiled = await services.load_compiled_definition(definition.id, 13);
  expect(compiled.stages.build?.materialization).toEqual(expect.objectContaining({ kind: "fan_out", max_parallel: 4 }));
  expect(services.load_compiled_definition(definition.id, 11)).rejects.toThrow("expected version 11");
});

test("production root checkpoints the logical run and DBOS attempt idempotently", async () => {
  const calls: string[] = [];
  const services = createProductionTopologyServices({ definitions: {} as WorkflowDefinitionRepository,
    runs: { async insert_launch(value) { calls.push(`run:${value.id}`); } } as WorkflowRunRepository,
    attempts: { async insert(value) { calls.push(`attempt:${value.root_workflow_id}:${value.forked_from_root_workflow_id}`); } } as WorkflowAttemptRepository,
    stages: {} as StageInstanceRepository, executions: {} as ExecutionProjectionRepository,
    rerun_targets: { async replace_execution_workflow() {}, async find_unit_target() { return null; } },
    resume_artifacts: { async list_latest_for_stages() { return []; } }, load_prompt_template: async () => "template" });
  await services.ensure_run({ run_id: "run-1" as never, root_workflow_id: "root-2", workflow_definition_id: "definition-1" as never,
    workflow_definition_version: 11, context: {}, created_at: "2026-08-14T00:00:00Z", forked_from_root_workflow_id: "root-1" });
  expect(calls).toEqual(["run:run-1", "attempt:root-2:root-1"]);
});

test("production stage service owns rerun projection replacement", async () => {
  const calls: string[] = [];
  const services = createProductionTopologyServices({ definitions: {} as WorkflowDefinitionRepository, runs: {} as WorkflowRunRepository,
    attempts: {} as WorkflowAttemptRepository, stages: {} as StageInstanceRepository, executions: {} as ExecutionProjectionRepository,
    rerun_targets: { async find_unit_target() { return null; }, async replace_execution_workflow(executionId, workflowId) { calls.push(`${executionId}:${workflowId}`); } },
    resume_artifacts: { async list_latest_for_stages() { return []; } }, load_prompt_template: async () => "template" });
  await services.replace_execution_projection({ execution_id: "execution-1" as never, replacement_workflow_id: "replacement-1" });
  expect(calls).toEqual(["execution-1:replacement-1"]);
});
