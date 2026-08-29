import { expect, test } from "bun:test";
import { createProductionTopologyServices } from "../src/runtime/production-services";
import { loadDevFlowV14 } from "../src/seed/dev-flow-v14";
import type { StageInstanceRepository, ExecutionProjectionRepository, WorkflowAttemptRepository, WorkflowDefinitionRepository, WorkflowRunRepository } from "../src/storage/repositories";

test("production services load and compile the immutable requested definition version", async () => {
  const loaded = await loadDevFlowV14();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const definition = loaded.value;
  const definitions = { find_by_id: async () => definition } as unknown as WorkflowDefinitionRepository;
  const services = createProductionTopologyServices({ definitions, runs: {} as WorkflowRunRepository, attempts: {} as WorkflowAttemptRepository,
    stages: {} as StageInstanceRepository, executions: {} as ExecutionProjectionRepository,
    rerun_targets: { async replace_execution_workflow() {}, async find_unit_target() { return null; } },
    resume_artifacts: { async list_latest_for_stages() { return []; } }, waits: { async find_handoff_waits_for_artifact() { return []; } }, load_prompt_template: async () => "template" });
  const compiled = await services.load_compiled_definition(definition.id, 14);
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
    resume_artifacts: { async list_latest_for_stages() { return []; } }, waits: { async find_handoff_waits_for_artifact() { return []; } }, load_prompt_template: async () => "template" });
  await services.ensure_run({ run_id: "run-1" as never, root_workflow_id: "root-2", workflow_definition_id: "definition-1" as never,
    workflow_definition_version: 11, context: {}, created_at: "2026-08-14T00:00:00Z", forked_from_root_workflow_id: "root-1" });
  expect(calls).toEqual(["run:run-1", "attempt:root-2:root-1"]);
});

test("production stage service owns rerun projection replacement", async () => {
  const calls: string[] = [];
  const services = createProductionTopologyServices({ definitions: {} as WorkflowDefinitionRepository, runs: {} as WorkflowRunRepository,
    attempts: {} as WorkflowAttemptRepository, stages: {} as StageInstanceRepository, executions: {} as ExecutionProjectionRepository,
    rerun_targets: { async find_unit_target() { return null; }, async replace_execution_workflow(executionId, workflowId) { calls.push(`${executionId}:${workflowId}`); } },
    resume_artifacts: { async list_latest_for_stages() { return []; } }, waits: { async find_handoff_waits_for_artifact() { return []; } }, load_prompt_template: async () => "template" });
  await services.replace_execution_projection({ execution_id: "execution-1" as never, replacement_workflow_id: "replacement-1" });
  expect(calls).toEqual(["execution-1:replacement-1"]);
});

test("production stage service reads a revision's handoff standing from its wait rows", async () => {
  const open = { id: "wait-1" as never, stage_instance_id: "stage-1" as never, unit_id: "web" as never, artifact_revision_id: "artifact-2" as never,
    closes_on: { kind: "handoff_downstream", downstream_role: "assessment" }, status: { kind: "open" }, run_unit_id: null, output_name: null,
    execution_workflow_id: "execution-1", command_workflow_id: "handoff-2", opened_at: "2026-08-27T00:00:00Z" } as const;
  const services = createProductionTopologyServices({ definitions: {} as WorkflowDefinitionRepository, runs: {} as WorkflowRunRepository,
    attempts: {} as WorkflowAttemptRepository, stages: {} as StageInstanceRepository, executions: {} as ExecutionProjectionRepository,
    rerun_targets: { async find_unit_target() { return null; }, async replace_execution_workflow() {} },
    resume_artifacts: { async list_latest_for_stages() { return []; } },
    waits: { async find_handoff_waits_for_artifact(artifact) { return artifact === open.artifact_revision_id ? [open] : []; } },
    load_prompt_template: async () => "template" });
  expect(await services.find_revision_handoff_state("artifact-2" as never)).toEqual(expect.objectContaining({ status: "awaiting_downstream", downstream_role: "assessment" }));
  expect(await services.find_revision_handoff_state("artifact-9" as never)).toBeNull();
});
