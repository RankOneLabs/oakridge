import { createHash, randomUUID } from "node:crypto";

import type { OperatorRunSummary } from "../domain/operator-projections";
import { err, ok, type Result, type WorkflowRunId } from "../domain/primitives";
import type { CreateWorkflowRunRequest } from "../domain/runs";
import { runRecordWorkflowId } from "../domain/workflow-ids";
import { parseV15WorkflowDefinition } from "../validation/v15-definition";
import { parseRunInputs } from "../validation/run-inputs";
import { prepareRunContext } from "./prepare-run-context";
import type { RunStartError, RunStartRequest } from "./run-launch-dispatch";
import type { OperatorProjectionRepository } from "../storage/postgres-operators";
import type { ProjectRepository, PromptBundleRepository, WorkflowDefinitionRepository, WorkflowRunRepository } from "../storage/repositories";

export interface RunLaunchRequest extends CreateWorkflowRunRequest {
  readonly idempotency_key: string | null;
}

export interface LaunchRunDependencies {
  readonly definitions: WorkflowDefinitionRepository & Pick<PromptBundleRepository, "find_bound_prompt_bundle">;
  readonly projects: ProjectRepository;
  readonly runs: WorkflowRunRepository;
  readonly projections: Pick<OperatorProjectionRepository, "list_runs">;
  readonly start_run: (request: RunStartRequest) => Promise<Result<void, RunStartError>>;
  readonly application_version: string | null;
  readonly adapter_version: string;
  readonly artifact_schema_version: string;
  readonly now: () => string;
  readonly new_id?: () => string;
}

export type RunLaunchFailureKind =
  | "definition_not_found"
  | "definition_archived"
  | "definition_invalid"
  | "project_not_found"
  | "invalid_context"
  /** The context is well-formed but this definition reads keys it does not carry. */
  | "context_requirements_unmet"
  | "idempotency_conflict"
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

export const launchRun = async (request: RunLaunchRequest, dependencies: LaunchRunDependencies): Promise<Result<OperatorRunSummary, RunLaunchError>> => {
  const definition = await dependencies.definitions.find_by_id(request.workflow_def_id);
  if (!definition) return launchFailure("definition_not_found", `workflow definition '${request.workflow_def_id}' was not found`);
  const runId = request.idempotency_key ? deterministicRunId(request.idempotency_key) : (dependencies.new_id ?? randomUUID)() as WorkflowRunId;
  const existing = await dependencies.runs.find_launch_by_id(runId);
  if (definition.archived && !existing) return launchFailure("definition_archived", `workflow definition '${request.workflow_def_id}' is archived`);
  let bundlePin = existing?.bundle_pin ?? null;
  if (!bundlePin) {
    const promptBundle = await dependencies.definitions.find_bound_prompt_bundle(definition.id);
    if (!promptBundle) return launchFailure("definition_invalid", `workflow definition '${request.workflow_def_id}' has no bound prompt bundle`);
    const parsed = parseV15WorkflowDefinition(definition.definition);
    if (!parsed.ok) return launchFailure("definition_invalid", parsed.error.detail);
    bundlePin = { definition_version: definition.version, prompt_bundle_hash: promptBundle.hash,
      adapter_version: dependencies.adapter_version, artifact_schema_version: dependencies.artifact_schema_version };
  }
  if (!bundlePin) return launchFailure("definition_invalid", "workflow definition has no bundle pin");
  const project = request.project_id ? await dependencies.projects.find_by_id(request.project_id) : null;
  if (request.project_id && !project) return launchFailure("project_not_found", `project '${request.project_id}' was not found`);
  const context = prepareRunContext({ caller_context: request.context, project, epic_profile: request.epic_profile });
  const validated = parseRunInputs(context);
  if (!validated.ok) return launchFailure("invalid_context", validated.error.detail);

  const createdAt = existing?.created_at ?? dependencies.now();
  // The epic configuration is already folded into `context` by
  // `prepareRunContext`; there is no profile row to persist beside the run.
  const persisted = await dependencies.runs.create_run({
    run: { id: runId, workflow_definition_id: definition.id, project_id: request.project_id, context, bundle_pin: bundlePin,
      archived: false, created_at: createdAt },
    workflow_definition_version: definition.version,
  });
  if (!persisted.ok) return launchFailure("idempotency_conflict", persisted.error.detail);
  // The run row is the durable intent; a failed start here is not a launch
  // failure — the sweep (`dispatchRunLaunches`) owns delivery and will retry
  // it, exactly as the deleted launch outbox used to retry a failed dispatch.
  const started = await dependencies.start_run({ workflow_id: runRecordWorkflowId(runId), run_id: runId,
    ...(dependencies.application_version ? { application_version: dependencies.application_version } : {}) });
  if (!started.ok) console.warn(`oakridge: run '${runId}' was created but its root workflow failed to start; the launch sweep will retry: ${started.error.detail}`);
  const summary = (await dependencies.projections.list_runs("all")).find((candidate) => candidate.id === runId);
  if (!summary) return launchFailure("projection_unavailable", `workflow run '${runId}' was enqueued but its operator projection is not available`);
  return ok(summary);
};
