import { expect, test } from "bun:test";
import { createProductionTopologyServices } from "../src/runtime/production-services";
import { loadDevFlowV11 } from "../src/seed/dev-flow-v11";
import type { StageInstanceRepository, ExecutionProjectionRepository, WorkflowAttemptRepository, WorkflowDefinitionRepository, WorkflowRunRepository } from "../src/storage/repositories";

test("production services load and compile the immutable requested definition version", async () => {
  const loaded = await loadDevFlowV11();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const definition = loaded.value;
  const definitions = { find_by_id: async () => definition } as unknown as WorkflowDefinitionRepository;
  const services = createProductionTopologyServices({ definitions, runs: {} as WorkflowRunRepository, attempts: {} as WorkflowAttemptRepository,
    stages: {} as StageInstanceRepository, executions: {} as ExecutionProjectionRepository,
    resume_artifacts: { async list_latest_for_stages() { return []; } }, load_prompt_template: async () => "template" });
  const compiled = await services.load_compiled_definition(definition.id, 11);
  expect(compiled.stages.build?.materialization).toEqual(expect.objectContaining({ kind: "fan_out", max_parallel: 4 }));
  expect(services.load_compiled_definition(definition.id, 10)).rejects.toThrow("expected version 10");
});

test("production root checkpoints the logical run and DBOS attempt idempotently", async () => {
  const calls: string[] = [];
  const services = createProductionTopologyServices({ definitions: {} as WorkflowDefinitionRepository,
    runs: { async insert_launch(value) { calls.push(`run:${value.id}`); } } as WorkflowRunRepository,
    attempts: { async insert(value) { calls.push(`attempt:${value.root_workflow_id}:${value.forked_from_root_workflow_id}`); } } as WorkflowAttemptRepository,
    stages: {} as StageInstanceRepository, executions: {} as ExecutionProjectionRepository,
    resume_artifacts: { async list_latest_for_stages() { return []; } }, load_prompt_template: async () => "template" });
  await services.ensure_run({ run_id: "run-1" as never, root_workflow_id: "root-2", workflow_definition_id: "definition-1" as never,
    workflow_definition_version: 11, context: {}, created_at: "2026-08-14T00:00:00Z", forked_from_root_workflow_id: "root-1" });
  expect(calls).toEqual(["run:run-1", "attempt:root-2:root-1"]);
});
