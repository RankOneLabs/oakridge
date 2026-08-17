import { err, ok, type Result, type WorkflowDefinitionId, type WorkflowRunId } from "../domain/primitives";
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

/**
 * Why a stage rerun could not be started, as a discriminant rather than prose.
 * The operator surface turns this into a 404/409 category; when it read the
 * classification out of the message text instead, rewording an error silently
 * moved runs between categories.
 */
export type StageRerunError =
  | { readonly kind: "run_not_found"; readonly run_id: WorkflowRunId }
  | { readonly kind: "definition_not_found"; readonly workflow_definition_id: WorkflowDefinitionId }
  | { readonly kind: "stage_not_found"; readonly stage_key: string }
  | { readonly kind: "run_has_no_attempt"; readonly run_id: WorkflowRunId }
  | { readonly kind: "rerun_id_belongs_to_another_run"; readonly rerun_id: string };

/** One place where a rerun failure becomes words. */
export const describeStageRerunError = (error: StageRerunError): string => {
  if (error.kind === "run_not_found") return `workflow run '${error.run_id}' was not found`;
  if (error.kind === "definition_not_found") return `workflow definition '${error.workflow_definition_id}' was not found`;
  if (error.kind === "stage_not_found") return `stage '${error.stage_key}' does not exist`;
  if (error.kind === "run_has_no_attempt") return `workflow run '${error.run_id}' has no DBOS attempt`;
  return `rerun ID '${error.rerun_id}' belongs to another run`;
};

/**
 * Whether the rerun target simply is not there, as opposed to being contested
 * by another attempt. A missing target is not a conflict, and reporting it as
 * one tells the operator to retry something that can never succeed.
 */
export const isMissingStageRerunTarget = (error: StageRerunError): boolean =>
  error.kind === "run_not_found" || error.kind === "definition_not_found" || error.kind === "stage_not_found";

export interface StageRerunDependencies {
  readonly runs: WorkflowRunRepository;
  readonly attempts: WorkflowAttemptRepository;
  readonly definitions: WorkflowDefinitionRepository;
  readonly dbos: StageRerunDbosClient;
  readonly now: () => string;
  readonly supersede_attempt: (root_workflow_id: string) => Promise<void>;
}

export const rerunStage = async (request: StageRerunRequest, dependencies: StageRerunDependencies): Promise<Result<StageRerunResult, StageRerunError>> => {
  const rootWorkflowId = `oakridge-stage-rerun:${request.run_id}:${request.stage_key}:${request.rerun_id}`;
  const run = await dependencies.runs.find_by_id(request.run_id);
  if (!run) return err({ kind: "run_not_found", run_id: request.run_id });
  const definition = await dependencies.definitions.find_by_id(run.workflow_definition_id);
  if (!definition) return err({ kind: "definition_not_found", workflow_definition_id: run.workflow_definition_id });
  if (!definition.graph.stages[request.stage_key]) return err({ kind: "stage_not_found", stage_key: request.stage_key });
  const existing = await dependencies.attempts.find_by_root_workflow_id(rootWorkflowId);
  if (existing) {
    if (existing.run_id !== request.run_id) return err({ kind: "rerun_id_belongs_to_another_run", rerun_id: request.rerun_id });
    if (existing.forked_from_root_workflow_id) await dependencies.supersede_attempt(existing.forked_from_root_workflow_id);
    return ok({ root_workflow_id: rootWorkflowId });
  }
  const attempts = await dependencies.attempts.list_for_run(request.run_id);
  const parent = attempts[attempts.length - 1];
  if (!parent) return err({ kind: "run_has_no_attempt", run_id: request.run_id });
  await dependencies.supersede_attempt(parent.root_workflow_id);
  const createdAt = dependencies.now();
  await dependencies.dbos.start_run(rootWorkflowId, { run_id: request.run_id, workflow_definition_id: definition.id,
    workflow_definition_version: definition.version, context: run.context, resume_from_stage: request.stage_key,
    created_at: createdAt, forked_from_root_workflow_id: parent.root_workflow_id }, request.application_version);
  await dependencies.attempts.insert({ root_workflow_id: rootWorkflowId, run_id: request.run_id,
    forked_from_root_workflow_id: parent.root_workflow_id, created_at: createdAt });
  return ok({ root_workflow_id: rootWorkflowId });
};
