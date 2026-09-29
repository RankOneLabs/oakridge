import type { FinalMergePolicy, ForgeRepositoryIdentity } from "./epic";
import type { ProjectId, Result, RootWorkflowId, WorkflowDefinitionId, WorkflowRunId } from "./primitives";
import type { RunContext } from "./run-context";
import type { WorkflowRunBundlePin } from "./workflow";

export interface CreateWorkflowRunRequest {
  readonly workflow_def_id: WorkflowDefinitionId;
  readonly project_id: ProjectId | null;
  readonly context: RunContext;
  readonly epic_profile: CreateEpicProfileRequest | null;
}

/**
 * The epic configuration a launch carries. Unchanged as a *request* shape — it
 * is the external contract `POST /workflow_runs` accepts — but it is no longer
 * persisted as a row: `prepareRunContext` folds every field of it into the
 * run's own context, which is the one thing every stage already reads.
 */
export interface CreateEpicProfileRequest {
  readonly title: string;
  readonly slug: string;
  readonly final_merge_policy: FinalMergePolicy;
  /** The one branch this epic builds on; `epic/<slug>` when unset. */
  readonly base_branch: string | null;
  readonly repositories: readonly CreateEpicRepositoryRequest[];
}

export interface CreateEpicRepositoryRequest {
  readonly repository_key: string;
  readonly repository_path: string;
  /** Where this repository's base branch is cut from, and where its work merges back. */
  readonly integration_branch: string;
  readonly forge_repository: ForgeRepositoryIdentity | null;
}

export interface WorkflowRunLaunchRecord {
  readonly id: WorkflowRunId;
  readonly workflow_definition_id: WorkflowDefinitionId;
  readonly project_id: ProjectId | null;
  readonly context: RunContext;
  readonly bundle_pin: WorkflowRunBundlePin;
  readonly root_workflow_id: string;
  readonly archived: boolean;
  readonly created_at: string;
}

/**
 * What `create_run` persists. `root_workflow_id` is absent — it is derived
 * (`runRecordWorkflowId`), never stored or compared — so a launch's replay
 * check has nothing here to compare it against.
 */
export interface PersistWorkflowRunLaunch {
  readonly run: Omit<WorkflowRunLaunchRecord, "root_workflow_id">;
  readonly workflow_definition_version: number;
}

/** A run whose durable intent is stored but whose root workflow has not started. */
export interface UnstartedRun {
  readonly run_id: WorkflowRunId;
  readonly workflow_id: RootWorkflowId;
}

export interface WorkflowRunListFilter {
  readonly archived: boolean | null;
  readonly workflow_definition_id?: WorkflowDefinitionId;
  readonly project_id?: ProjectId;
}

export type CreateWorkflowRunResult = Result<{
  readonly kind: "created" | "replayed";
  readonly run: WorkflowRunLaunchRecord;
}, {
  readonly operation: "create_workflow_run";
  readonly kind: "definition_not_found" | "definition_archived" | "project_not_found" | "invalid_context" | "idempotency_conflict";
  readonly detail: string;
}>;

export type SetRunArchiveResult =
  | { readonly kind: "updated" | "unchanged"; readonly run_id: WorkflowRunId; readonly archived: boolean }
  | { readonly kind: "not_found"; readonly run_id: WorkflowRunId };

export type DeleteRunResult =
  | { readonly kind: "deleted" | "already_deleted"; readonly run_id: WorkflowRunId }
  | { readonly kind: "active_conflict" | "cancellation_pending" | "external_execution_conflict"; readonly run_id: WorkflowRunId; readonly detail: string };
