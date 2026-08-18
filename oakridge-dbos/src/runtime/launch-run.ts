import { createHash, randomUUID } from "node:crypto";

import type { EpicWorkflowProfileId } from "../domain/epic";
import type { OperatorRunSummary } from "../domain/operator-projections";
import { err, ok, type Result, type WorkflowRunId } from "../domain/primitives";
import type { CreateWorkflowRunRequest } from "../domain/runs";
import { createEpicProfile, prepareRunContext } from "./prepare-run-context";
import { describeRepositoryPreconditionFailures, selectRepositoryPreconditions, type RepositoryPreconditionChecker } from "../domain/repository-preconditions";
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
  /**
   * Verifies the repository state a run assumes. Optional so a caller with no
   * repositories — or a test — need not supply one; when absent, nothing is
   * checked and the previous behaviour stands.
   */
  readonly repository_preconditions?: RepositoryPreconditionChecker;
}

export type RunLaunchFailureKind =
  | "definition_not_found"
  | "definition_archived"
  | "project_not_found"
  | "invalid_context"
  | "idempotency_conflict"
  | "repository_precondition_unmet"
  | "projection_unavailable";

export interface RunLaunchError {
  readonly operation: "launch_compatible_run";
  readonly kind: RunLaunchFailureKind;
  readonly detail: string;
}

const launchFailure = (kind: RunLaunchFailureKind, detail: string): Result<never, RunLaunchError> =>
  err({ operation: "launch_compatible_run", kind, detail });

export const deterministicRunId = (idempotencyKey: string): WorkflowRunId => {
  const hex = createHash("sha256").update(`oakridge-run:${idempotencyKey}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}` as WorkflowRunId;
};

export const launchCompatibleRun = async (request: CompatibleRunLaunchRequest, dependencies: LaunchRunDependencies): Promise<Result<OperatorRunSummary, RunLaunchError>> => {
  const definition = await dependencies.definitions.find_by_id(request.workflow_def_id);
  if (!definition) return launchFailure("definition_not_found", `workflow definition '${request.workflow_def_id}' was not found`);
  const runId = request.idempotency_key ? deterministicRunId(request.idempotency_key) : (dependencies.new_id ?? randomUUID)() as WorkflowRunId;
  const existing = await dependencies.runs.find_launch_by_id(runId);
  if (definition.archived && !existing) return launchFailure("definition_archived", `workflow definition '${request.workflow_def_id}' is archived`);
  const project = request.project_id ? await dependencies.projects.find_by_id(request.project_id) : null;
  if (request.project_id && !project) return launchFailure("project_not_found", `project '${request.project_id}' was not found`);
  const prepared = prepareRunContext({ caller_context: request.context, project, epic_profile: request.epic_profile });
  if (!prepared.ok) return launchFailure("invalid_context", prepared.error.detail);

  // Checked before anything is persisted. Nothing creates the epic branch, and
  // the first stage that needs it is `build` — so without this a run burns
  // three agent sessions and three operator approvals before failing on a
  // branch that never existed. Skipped for a re-launch of an existing run,
  // whose repositories were already accepted.
  if (dependencies.repository_preconditions && !existing) {
    const failures = await dependencies.repository_preconditions.check(selectRepositoryPreconditions(prepared.value));
    if (failures.length > 0) return launchFailure("repository_precondition_unmet", describeRepositoryPreconditionFailures(failures));
  }

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
  if (!persisted.ok) return launchFailure("idempotency_conflict", persisted.error.detail);
  await dependencies.dispatch_launches();
  const summary = (await dependencies.projections.list_runs("all")).find((candidate) => candidate.id === runId);
  if (!summary) return launchFailure("projection_unavailable", `workflow run '${runId}' was enqueued but its operator projection is not available`);
  return ok(summary);
};

// Compatibility aliases retained for callers while the HTTP boundary migrates.
export type LaunchRunRequest = CompatibleRunLaunchRequest;
export const launchRun = launchCompatibleRun;
