import type { EpicWorkflowProfile } from "./epic";
import type { JsonValue, ProjectId, Result, RootWorkflowId, StageInstanceId, UnitId, WorkflowDefinitionId, WorkflowRunId } from "./primitives";
import type { RunContext } from "./run-context";

export interface CreateWorkflowRunRequest {
  readonly workflow_def_id: WorkflowDefinitionId;
  readonly project_id: ProjectId | null;
  readonly context: RunContext;
  readonly epic_profile: CreateEpicProfileRequest | null;
}

export interface CreateEpicProfileRequest {
  readonly title: string;
  readonly slug: string;
  readonly final_merge_policy: EpicWorkflowProfile["final_merge_policy"];
  /** The one branch this epic builds on; `epic/<slug>` when unset. */
  readonly base_branch: string | null;
  readonly repositories: readonly CreateEpicRepositoryRequest[];
}

export interface CreateEpicRepositoryRequest {
  readonly repository_key: string;
  readonly repository_path: string;
  /** Where this repository's base branch is cut from, and where its work merges back. */
  readonly integration_branch: string;
  readonly forge_repository: EpicWorkflowProfile["repositories"][number]["forge_repository"];
}

export interface WorkflowRunLaunchRecord {
  readonly id: WorkflowRunId;
  readonly workflow_definition_id: WorkflowDefinitionId;
  readonly project_id: ProjectId | null;
  readonly context: RunContext;
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
  readonly epic_profile: EpicWorkflowProfile | null;
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
  readonly epic_profile: EpicWorkflowProfile | null;
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

export interface AdmitStageUnitRequest {
  readonly stage_instance_id: StageInstanceId;
  readonly unit_id: UnitId;
  readonly idempotency_key: string;
}

export type AdmitStageUnitResult =
  | { readonly kind: "admitted" | "already_admitted"; readonly stage_instance_id: StageInstanceId; readonly unit_id: UnitId }
  | { readonly kind: "stage_not_found" | "unit_not_found" | "not_manual" | "not_pending"; readonly stage_instance_id: StageInstanceId; readonly unit_id: UnitId }
  | { readonly kind: "idempotency_conflict"; readonly stage_instance_id: StageInstanceId; readonly unit_id: UnitId };

export interface StageAdmissionUnitState {
  readonly unit_id: UnitId;
  readonly parameters: JsonValue;
  readonly admitted: boolean;
  readonly eligible: boolean;
  readonly blocked_by: readonly UnitId[];
}

export interface StageAdmissionState {
  readonly stage_instance_id: StageInstanceId;
  readonly status: "waiting" | "closed";
  readonly manual_admission: boolean;
  readonly units: readonly StageAdmissionUnitState[];
}

export interface RetryStuckRequest {
  readonly stage_instance_id: StageInstanceId;
  readonly unit_id: UnitId | null;
}

export type RetryStuckResult =
  | { readonly kind: "accepted_unit" | "accepted_stage" | "already_accepted"; readonly stage_instance_id: StageInstanceId; readonly unit_id: UnitId | null }
  | { readonly kind: "stage_not_found" | "unit_not_found" | "not_stuck" | "active_conflict"; readonly stage_instance_id: StageInstanceId; readonly unit_id: UnitId | null; readonly detail: string };
