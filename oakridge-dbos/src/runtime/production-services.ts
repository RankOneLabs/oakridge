import { compileWorkflowDefinition } from "../compiler/compile-workflow";
import type { WorkflowDefinitionRepository, StageInstanceRepository, ExecutionProjectionRepository, ResumeArtifactRepository, RerunTargetRepository, WorkflowAttemptRepository, WorkflowRunRepository } from "../storage/repositories";
import type { ProductionTopologyServices } from "../workflows/production-topology";

export interface ProductionServiceDependencies {
  readonly definitions: WorkflowDefinitionRepository;
  readonly runs: WorkflowRunRepository;
  readonly attempts: WorkflowAttemptRepository;
  readonly stages: StageInstanceRepository;
  readonly executions: ExecutionProjectionRepository;
  readonly rerun_targets: RerunTargetRepository;
  readonly resume_artifacts: ResumeArtifactRepository;
  readonly load_prompt_template: (path: string) => Promise<string>;
}

export const createProductionTopologyServices = (dependencies: ProductionServiceDependencies): ProductionTopologyServices => ({
  async ensure_run(input) {
    await dependencies.runs.insert_launch({ id: input.run_id, workflow_definition_id: input.workflow_definition_id, context: input.context });
    await dependencies.attempts.insert({ root_workflow_id: input.root_workflow_id, run_id: input.run_id,
      forked_from_root_workflow_id: input.forked_from_root_workflow_id ?? null, created_at: input.created_at ?? new Date().toISOString() });
  },
  async load_compiled_definition(id, version) {
    const definition = await dependencies.definitions.find_by_id(id);
    if (!definition) throw new Error(`workflow definition '${id}' was not found`);
    if (definition.version !== version) throw new Error(`workflow definition '${id}' expected version ${version}, found ${definition.version}`);
    const compiled = compileWorkflowDefinition(definition);
    if (!compiled.ok) throw new Error(`${compiled.error.operation}:${compiled.error.stage_key ?? "workflow"}:${compiled.error.detail}`);
    return compiled.value;
  },
  load_prompt_template: dependencies.load_prompt_template,
  async find_external_reference(execution_id) { return (await dependencies.executions.find_external(execution_id))?.external_reference ?? null; },
  async start_stage(input) {
    await dependencies.stages.start({ id: input.stage_instance_id, run_id: input.run_id, stage_key: input.stage.stage_key, stage_type: input.stage.stage_type,
      stage_contract: input.stage as unknown as import("../domain/primitives").JsonValue, attempt_root_workflow_id: input.attempt_root_workflow_id,
      coordinator_workflow_id: input.coordinator_workflow_id, started_at: input.started_at });
  },
  async finish_stage(input) { await dependencies.stages.finish(input.stage_instance_id, input.ended_at, input.outcome); },
  async record_execution(input) { await dependencies.executions.record(input.request, input.execution_workflow_id, input.parameters); },
  async replace_execution_projection(input) { await dependencies.rerun_targets.replace_execution_workflow(input.execution_id, input.replacement_workflow_id); },
  load_resume_artifacts(run_id, stage_keys) { return dependencies.resume_artifacts.list_latest_for_stages(run_id, stage_keys); },
});
