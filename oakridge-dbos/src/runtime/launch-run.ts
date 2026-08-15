import { createHash, randomUUID } from "node:crypto";

import type { EpicWorkflowProfileId } from "../domain/epic";
import type { OperatorRunSummary } from "../domain/operator-projections";
import type { WorkflowRunId } from "../domain/primitives";
import type { CreateWorkflowRunRequest } from "../domain/runs";
import { createEpicProfile, prepareRunContext } from "./prepare-run-context";
import type { OperatorProjectionRepository } from "../storage/postgres-operators";
import type { ProjectRepository, WorkflowDefinitionRepository, WorkflowRunRepository } from "../storage/repositories";

export interface CompatibleRunLaunchRequest extends CreateWorkflowRunRequest {
  readonly idempotency_key: string | null;
}

export interface LaunchRunDependencies {
  readonly definitions: WorkflowDefinitionRepository;
  readonly projects: ProjectRepository;
  readonly runs: WorkflowRunRepository;
  readonly projections: Pick<OperatorProjectionRepository, "list_runs">;
  readonly dispatch_launches: () => Promise<number>;
  readonly application_version: string | null;
  readonly now: () => string;
  readonly new_id?: () => string;
}

export class CompatibleRunLaunchError extends Error {
  constructor(readonly kind: "definition_not_found" | "definition_archived" | "project_not_found" | "invalid_context" | "idempotency_conflict" | "projection_unavailable", message: string) {
    super(message);
  }
}

export const deterministicRunId = (idempotencyKey: string): WorkflowRunId => {
  const hex = createHash("sha256").update(`oakridge-run:${idempotencyKey}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}` as WorkflowRunId;
};

export const launchCompatibleRun = async (request: CompatibleRunLaunchRequest, dependencies: LaunchRunDependencies): Promise<OperatorRunSummary> => {
  const definition = await dependencies.definitions.find_by_id(request.workflow_def_id);
  if (!definition) throw new CompatibleRunLaunchError("definition_not_found", `workflow definition '${request.workflow_def_id}' was not found`);
  const runId = request.idempotency_key ? deterministicRunId(request.idempotency_key) : (dependencies.new_id ?? randomUUID)() as WorkflowRunId;
  const existing = await dependencies.runs.find_launch_by_id(runId);
  if (definition.archived && !existing) throw new CompatibleRunLaunchError("definition_archived", `workflow definition '${request.workflow_def_id}' is archived`);
  const project = request.project_id ? await dependencies.projects.find_by_id(request.project_id) : null;
  if (request.project_id && !project) throw new CompatibleRunLaunchError("project_not_found", `project '${request.project_id}' was not found`);
  const prepared = prepareRunContext({ caller_context: request.context, project, epic_profile: request.epic_profile });
  if (!prepared.ok) throw new CompatibleRunLaunchError("invalid_context", prepared.error.detail);

  const createdAt = existing?.created_at ?? dependencies.now();
  const rootWorkflowId = `oakridge-run:${runId}:attempt:initial`;
  const epicProfile = request.epic_profile ? createEpicProfile({ id: runId as unknown as EpicWorkflowProfileId,
    workflow_run_id: runId, config: request.epic_profile, created_at: createdAt }) : null;
  const persisted = await dependencies.runs.create_with_initial_attempt({
    run: { id: runId, workflow_definition_id: definition.id, project_id: request.project_id, context: prepared.value,
      root_workflow_id: rootWorkflowId, archived: false, created_at: createdAt },
    epic_profile: epicProfile, workflow_definition_version: definition.version,
    application_version: dependencies.application_version,
  });
  if (!persisted.ok) throw new CompatibleRunLaunchError("idempotency_conflict", persisted.error.detail);
  await dependencies.dispatch_launches();
  const summary = (await dependencies.projections.list_runs("all")).find((candidate) => candidate.id === runId);
  if (!summary) throw new CompatibleRunLaunchError("projection_unavailable", `workflow run '${runId}' was enqueued but its operator projection is not available`);
  return summary;
};

// Compatibility aliases retained for callers while the HTTP boundary migrates.
export type LaunchRunRequest = CompatibleRunLaunchRequest;
export const launchRun = launchCompatibleRun;
