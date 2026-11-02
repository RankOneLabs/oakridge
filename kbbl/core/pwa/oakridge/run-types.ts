// Runs, their events, stages, epics and agent sessions on the operator surface.

import type { CreateRunContext } from "./project-types";
export type RepositoryKey = string & { readonly __brand: "RepositoryKey" };

export type CohortId = string & { readonly __brand: "CohortId" };

export type EpicProfileId = string & { readonly __brand: "EpicProfileId" };

export type WorkflowRunId = string & { readonly __brand: "WorkflowRunId" };

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type RunEventOperation =
  | "stage_materialized" | "materialization_closed" | "materialization_failed" | "run_cancelled"
  | "unit_admitted" | "operator_retry_created" | "input_revised" | "slot_released" | "slot_pending"
  | "slot_invalidated" | "unit_satisfied" | "work_started" | "gate_opened" | "gate_decided"
  | "pull_request_observed" | "pull_request_merge_confirmed";

export interface RunEventPayload {
  readonly run_id: WorkflowRunId;
  readonly run_unit_id: string | null;
  readonly stage_instance_id: string | null;
  readonly stage_key: string | null;
  readonly unit_id: string | null;
  readonly work_order_id: string | null;
  readonly wait_id: string | null;
  readonly output_name: string | null;
  readonly collection_key: string | null;
  readonly artifact_revision_id: string | null;
  readonly attention: "required" | "optional" | "none" | null;
  readonly continuation: "waiting" | "continuing" | null;
  readonly detail: JsonValue;
}

type GateRunEventOperation = "gate_opened" | "gate_decided";
type PullRequestRunEventOperation = "pull_request_observed" | "pull_request_merge_confirmed";
type OtherRunEventOperation = Exclude<RunEventOperation, GateRunEventOperation | PullRequestRunEventOperation>;

export interface GateRunEventPayload extends RunEventPayload {
  readonly run_unit_id: string;
  readonly stage_instance_id: string;
  readonly stage_key: string;
  readonly unit_id: string;
  readonly wait_id: string;
  readonly output_name: string;
  readonly artifact_revision_id: string;
  readonly attention: "required" | "optional" | "none";
  readonly continuation: "waiting" | "continuing";
}

export interface PullRequestRunEventPayload extends RunEventPayload {
  readonly run_unit_id: string;
  readonly stage_instance_id: string;
  readonly stage_key: string;
  readonly unit_id: string;
  readonly artifact_revision_id: string;
  readonly detail: {
    readonly [key: string]: JsonValue;
    readonly repository_key: string;
    readonly pull_request_url: string;
    readonly state: string;
    readonly source: string;
    readonly merged_at: string | null;
  };
}

interface RunEventEnvelope<Operation extends RunEventOperation, Payload extends RunEventPayload> {
  readonly sequence: string;
  readonly operation: Operation;
  readonly payload: Payload;
  readonly occurred_at: string;
}

export type RunEvent =
  | RunEventEnvelope<GateRunEventOperation, GateRunEventPayload>
  | RunEventEnvelope<PullRequestRunEventOperation, PullRequestRunEventPayload>
  | RunEventEnvelope<OtherRunEventOperation, RunEventPayload>;

export type RunEventFrame = RunEvent & { readonly replayed: boolean };

export interface RepositoryInputDraft {
  key: string;
  path: string;
  forge_owner: string;
  forge_name: string;
  integration_branch: string;
}

export interface RepositoryInput {
  key: RepositoryKey;
  path: string;
  /** Where this repository's base branch is cut from — `main`, typically. */
  integration_branch: string;
}

export interface ForgeRepositoryIdentity {
  provider: "github";
  owner: string;
  name: string;
}

export interface EpicRepositoryConfig {
  repository_key: RepositoryKey;
  repository_path: string;
  // Where this repository's base branch is cut from, and where its work merges
  // back — `main`, typically. The branch the run *builds on* is the epic's, one
  // for the whole run, and lives on EpicProfileConfig.
  integration_branch: string;
  forge_repository: ForgeRepositoryIdentity;
}

export type FinalMergePolicy = "guarded" | "external_confirmation";

export interface EpicProfileConfig {
  title: string;
  slug: string;
  final_merge_policy: FinalMergePolicy;
  /** The one branch this epic builds on; the server defaults it to `epic/<slug>`. */
  base_branch?: string | null;
  repositories: EpicRepositoryConfig[];
}

export type EpicLifecycleState = "draft" | "active" | "final_integration" | "completed" | "failed";

export type FinalMergeState = "pending" | "pull_request_open" | "awaiting_confirmation" | "merged" | "closed_without_merge";

export interface PullRequestReference {
  number: number;
  url: string;
  head_branch: string;
  base_branch: string;
}

export interface EpicRepositoryBinding {
  repository_key: RepositoryKey;
  repository_path: string;
  integration_branch: string;
  forge_repository: ForgeRepositoryIdentity | null;
  final_pull_request: PullRequestReference | null;
  final_merge_state: FinalMergeState;
}

export interface EpicWorkflowProfile {
  id: EpicProfileId;
  workflow_run_id: WorkflowRunId;
  title: string;
  slug: string;
  lifecycle_state: EpicLifecycleState;
  final_merge_policy: FinalMergePolicy;
  /** The one branch this epic builds on, and the head of every final PR. */
  base_branch: string;
  repositories: EpicRepositoryBinding[];
  created_at: string;
  updated_at: string;
}

export interface ConfirmFinalPullRequestRequest {
  idempotency_key: string;
  operator_comment?: string;
}

type FinalPullRequestOutcome =
  | "waiting"
  | "completed"
  | "already_completed"
  | "mismatch"
  | "ignored_stale"
  | "awaiting_external_confirmation";

export type FinalPullRequestResponse = {
  [Outcome in FinalPullRequestOutcome]: {
    outcome: Outcome;
    profile: EpicWorkflowProfile;
  };
}[FinalPullRequestOutcome];

export interface CreateRunRequest {
  workflow_def_id: string;
  project_id: string | null;
  context: CreateRunContext;
  epic_profile: EpicProfileConfig;
}

export type RunStatus = "pending" | "running" | "parked" | "failed" | "complete" | "cancelled";

export type RunDisplayStatus = RunStatus | "stuck";

/** The run's own persisted lifecycle state, distinct from the derived `RunStatus` above — carried on a gate row so a stranded gate can say what happened to its run. */
export type RunState = "active" | "succeeded" | "failed" | "cancelled";

export interface RunSummary {
  id: string;
  title: string | null;
  repository_keys: string[];
  workflow_name: string;
  status: RunStatus;
  current_stage: string | null;
  stage_total: number;
  stage_complete: number;
  parked_count: number;
  updated_at: string;
  is_stuck: boolean;
  is_failed: boolean;
  archived?: boolean;
}

export interface WorktreeMetadata {
  branch: string;
  path: string;
  base_ref: string;
}

export type StageStatus = "pending" | "running" | "complete" | "failed" | "parked";

export type StageUnitStatus = StageStatus;

export interface StageArtifact {
  id: string;
  type_id: string;
  version: number;
  label?: string | null;
  /**
   * `OperatorStageArtifact.created_at` (`oakridge-dbos`
   * `src/domain/operator-projections.ts`): when *this version* was written,
   * i.e. the slot's latest visible release — not the artifact chain's birth.
   * Optional because a backend older than this field still answers without it.
   */
  created_at?: string;
}

export interface StageUnit {
  unit_id: string;
  repository_key?: RepositoryKey | null;
  params?: StageUnitParams | null;
  sid: string | null;
  worktree: WorktreeMetadata | null;
  base_sha?: string | null;
  status: StageStatus;
  gate: string | null;
  /** Oakridge offers a retry decision for this unit now. */
  is_retryable: boolean;
}

/**
 * `run_unit.parameters` verbatim (`GET /runs/:id`, `postgres-operators.ts`):
 * the fan-out item `derive` minted — `{unit_id, artifact}` — not the
 * `dev.plan` cohort shape this used to wrongly claim. `artifact` is
 * `unknown` because its real type varies by producing stage (a build unit's
 * is a `dev.build_brief` body; an assessor unit's is `dev.build_result`);
 * narrow it with a type guard, never trust the shape blind.
 */
export interface StageUnitParams {
  unit_id?: string;
  artifact?: unknown;
}

export interface StageDetail {
  stage_instance_id: string;
  name: string;
  type: string;
  status: StageStatus;
  artifacts: StageArtifact[];
  delegated_kbbl_sid: string | null;
  worktree: WorktreeMetadata | null;
  units?: StageUnit[];
}

export interface RunDetail {
  id: string;
  title: string | null;
  repository_keys: string[];
  workflow_name: string;
  status: RunStatus;
  stages: StageDetail[];
  parked_count: number;
  updated_at: string;
  is_stuck: boolean;
  epic_profile?: EpicWorkflowProfile | null;
}

/**
 * Why a work order exists — `oakridge.work_order.reason`
 * (`migrations/0011_run_owned_work.sql:69`), mirrored from
 * `OperatorRunSessionAttempt["reason"]`. This is the attempt's label in the UI:
 * it is the column the retry path actually writes, so the label cannot drift
 * from the record.
 */
export type WorkOrderReason = "initial" | "operator_retry" | "input_revision";

/** `oakridge.work_order.state` (`migrations/0011_run_owned_work.sql:72`). */
export type WorkOrderState = "available" | "started" | "completed" | "abandoned";

/**
 * One executor attempt at one unit, mirroring `OperatorRunSessionAttempt`
 * (`oakridge-dbos/src/domain/operator-projections.ts`) — `GET /runs/:id/sessions`.
 *
 * Every attempt keeps its own session for the unit's whole life, so a unit
 * that was retried contributes one entry per attempt, not one per unit.
 */
export interface RunSessionAttempt {
  work_order_id: string;
  /** kbbl's session id, not a domain uuid. */
  session_id: string;
  stage_instance_id: string;
  stage_key: string;
  /** Human-readable worker role; the stage key still identifies the gate. */
  display_label?: string;
  unit_id: string;
  reason: WorkOrderReason;
  work_order_state: WorkOrderState;
  created_at: string;
  /** Null while the attempt is `available` or `started`. */
  completed_at: string | null;
  /** Null when nothing has observed the executor yet. */
  executor_health_kind: string | null;
  cleanup_state: string;
}

/**
 * Where a session sits in the run graph, mirroring
 * `OperatorSessionRunLocation` (`oakridge-dbos/src/domain/operator-projections.ts`)
 * — `GET /sessions/:session_id/run`.
 *
 * Unconditional by design: this answers navigation, which stays true after the
 * work order finished and its cleanup completed. It is not a session *hold*,
 * which answers whether the session is safe to close.
 */
export interface SessionRunLocation {
  run_id: WorkflowRunId;
  stage_instance_id: string;
  stage_key: string;
  unit_id: string;
  work_order_id: string;
}
