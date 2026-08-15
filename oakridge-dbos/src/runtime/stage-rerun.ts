import type { WorkflowRunId } from "../domain/primitives";
import type { WorkflowAttemptRepository, WorkflowDefinitionRepository, WorkflowRunRepository } from "../storage/repositories";
import type { RunWorkflowInput } from "../workflows/production-topology";

export interface StageRerunDbosClient {
  start_run(workflow_id: string, input: RunWorkflowInput, application_version?: string): Promise<void>;
}

export interface StageRerunRequest {
  readonly run_id: WorkflowRunId;
  readonly stage_key: string;
  readonly rerun_id: string;
  readonly application_version?: string;
}

export interface StageRerunResult { readonly root_workflow_id: string }

export interface StageRerunDependencies {
  readonly runs: WorkflowRunRepository;
  readonly attempts: WorkflowAttemptRepository;
  readonly definitions: WorkflowDefinitionRepository;
  readonly dbos: StageRerunDbosClient;
  readonly now: () => string;
  readonly supersede_attempt: (root_workflow_id: string) => Promise<void>;
}

export const rerunStage = async (request: StageRerunRequest, dependencies: StageRerunDependencies): Promise<StageRerunResult> => {
  const rootWorkflowId = `oakridge-stage-rerun:${request.run_id}:${request.stage_key}:${request.rerun_id}`;
  const run = await dependencies.runs.find_by_id(request.run_id);
  if (!run) throw new Error(`workflow run '${request.run_id}' was not found`);
  const definition = await dependencies.definitions.find_by_id(run.workflow_definition_id);
  if (!definition) throw new Error(`workflow definition '${run.workflow_definition_id}' was not found`);
  if (!definition.graph.stages[request.stage_key]) throw new Error(`stage '${request.stage_key}' does not exist`);
  const existing = await dependencies.attempts.find_by_root_workflow_id(rootWorkflowId);
  if (existing) {
    if (existing.run_id !== request.run_id) throw new Error(`rerun ID '${request.rerun_id}' belongs to another run`);
    if (existing.forked_from_root_workflow_id) await dependencies.supersede_attempt(existing.forked_from_root_workflow_id);
    return { root_workflow_id: rootWorkflowId };
  }
  const attempts = await dependencies.attempts.list_for_run(request.run_id);
  const parent = attempts[attempts.length - 1];
  if (!parent) throw new Error(`workflow run '${request.run_id}' has no DBOS attempt`);
  await dependencies.supersede_attempt(parent.root_workflow_id);
  const createdAt = dependencies.now();
  await dependencies.dbos.start_run(rootWorkflowId, { run_id: request.run_id, workflow_definition_id: definition.id,
    workflow_definition_version: definition.version, context: run.context, resume_from_stage: request.stage_key,
    created_at: createdAt, forked_from_root_workflow_id: parent.root_workflow_id }, request.application_version);
  await dependencies.attempts.insert({ root_workflow_id: rootWorkflowId, run_id: request.run_id,
    forked_from_root_workflow_id: parent.root_workflow_id, created_at: createdAt });
  return { root_workflow_id: rootWorkflowId };
};
