import type { JsonValue, WorkflowDefinitionId, WorkflowRunId } from "../domain/primitives";
import type { WorkflowDefinitionRepository } from "../storage/repositories";
import type { StageRerunDbosClient } from "./stage-rerun";

export interface LaunchRunRequest { readonly run_id: WorkflowRunId; readonly workflow_definition_id: WorkflowDefinitionId; readonly context: JsonValue; readonly application_version?: string }
export interface LaunchRunDependencies { readonly definitions: WorkflowDefinitionRepository; readonly dbos: StageRerunDbosClient; readonly now: () => string }

export const launchRun = async (request: LaunchRunRequest, dependencies: LaunchRunDependencies): Promise<{ readonly root_workflow_id: string }> => {
  const definition = await dependencies.definitions.find_by_id(request.workflow_definition_id);
  if (!definition) throw new Error(`workflow definition '${request.workflow_definition_id}' was not found`);
  const rootWorkflowId = `oakridge-run:${request.run_id}:attempt:initial`;
  await dependencies.dbos.start_run(rootWorkflowId, { run_id: request.run_id, workflow_definition_id: definition.id,
    workflow_definition_version: definition.version, context: request.context, created_at: dependencies.now(), forked_from_root_workflow_id: null }, request.application_version);
  return { root_workflow_id: rootWorkflowId };
};
