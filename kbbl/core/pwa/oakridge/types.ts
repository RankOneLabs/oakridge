/** IDs are validated and branded at the UI boundary; JSON carries strings. */
type OperatorWire<Value> = Value extends string & { readonly __brand: string } ? string
  : Value extends number & { readonly __brand: string } ? number
  : Value extends readonly (infer Member)[] ? OperatorWire<Member>[]
  : Value extends object ? { -readonly [Key in keyof Value]: OperatorWire<Value[Key]> } : Value;
type OperatorFields<Source, Required extends keyof Source, Optional extends keyof Source = never> =
  OperatorWire<Pick<Source, Required>> & Partial<OperatorWire<Pick<Source, Optional>>>;

import type * as Operator from "./operator-contracts";
import type { WorkflowDefinitionDescriptor } from "./workflow-definition-types";
import type { AgentSettings, OperatorWorkerRecord } from "./operator-worker-types";
export type { CoreStatus, BlockedReason, NextActor } from "./operator-worker-types";
import type { CoreStatus } from "./operator-worker-types";
export type { RunEvent, RunEventEffect } from "./run-event-types";
import type { RunEvent } from "./run-event-types";
// View-model types for the oakridge operator surface.
// These are typed at the PWA boundary and cover what the operator UI needs.


export interface OakridgeConfig {
  available: boolean;
  core_url?: string | null;
}

export type ProjectId = string & { readonly __brand: "ProjectId" };

export interface Project {
  id: ProjectId;
  name: string;
  repo_dir: string;
  created_at: string;
  forge_repository?: ForgeRepositoryIdentity | null;
  integration_branch?: string | null;
}

export interface ProjectWriteInput {
  readonly name: string;
  readonly repo_dir: string;
}

export interface ProjectUpdateCommand {
  readonly id: ProjectId;
  readonly project: ProjectWriteInput;
}

export interface ProjectUpdateError {
  readonly operation: "update project";
  readonly path: string;
  readonly detail: string;
}

export interface WorkflowDefSummary {
  id: string;
  name: string;
  version: number;
  // Retired from the launcher. The def still resolves for the runs that used it.
  archived?: boolean;
  // GET /workflow_defs returns the full def today; keep this optional for a
  // future trimmed summary response.
  definition?: WorkflowDefinitionDescriptor;
}

// Each role ships runtime, model, and effort together. A model is only valid
// against the runtime it was chosen from, so sending a model without its runtime
// is what let a codex planner model reach a claude-code-pinned stage.
export interface CreateRunContext {
  brief_notes: string;
  /** The one branch this run builds on. Every build unit's PR targets it. */
  base_branch: string;
  repositories: RepositoryInput[];
  oakridge_url: string;
  planner: AgentSettings;
  builder: AgentSettings;
}

export type RepositoryKey = string & { readonly __brand: "RepositoryKey" };
export type CohortId = string & { readonly __brand: "CohortId" };
export type WorkflowRunId = string & { readonly __brand: "WorkflowRunId" };
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

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


export interface CreateRunRequest {
  workflow_def_id: string;
  project_id: string | null;
  context: CreateRunContext;
  epic_profile: EpicProfileConfig;
}

export type RunStatus = CoreStatus;
export type RunDisplayStatus = RunStatus;

/** The run's committed lifecycle status carried on a gate row. */
export type RunState = CoreStatus;

export type RunSummary = OperatorFields<Operator.OperatorRunSummary,
  "id" | "title" | "repository_keys" | "workflow_name" | "status" | "blocked_reason" | "next_actor" | "current_stage" | "stage_total" | "stage_complete" | "attention_count" | "parked_count" | "updated_at",
  "archived">;

export interface WorktreeMetadata {
  branch: string;
  path: string;
  base_ref: string;
}

export type StageStatus = CoreStatus;
export type StageUnitStatus = StageStatus;

export type StageArtifact = OperatorFields<Operator.OperatorStageArtifact,
  "id" | "type_id" | "version",
  "cohort_id" | "label" | "created_at">;

export type StageUnit = OperatorFields<Operator.OperatorStageUnit,
  "version" | "cohort_id" | "unit_id" | "brief" | "sid" | "worktree" | "status" | "blocked_reason" | "next_actor" | "retryable" | "gate",
  "state" | "base_sha"> & {
  workers: readonly OperatorWorkerRecord[];
  repository_key?: RepositoryKey | null;
};

export type StageDetail = OperatorFields<Operator.OperatorStageDetail,
  "stage_instance_id" | "name" | "type" | "status" | "blocked_reason" | "next_actor" | "delegated_kbbl_sid" | "worktree"> & {
  artifacts: StageArtifact[];
  units?: StageUnit[];
};

export type RunDetail = OperatorFields<Operator.OperatorRunDetail,
  "id" | "title" | "repository_keys" | "workflow_name" | "status" | "blocked_reason" | "next_actor" | "parked_count" | "updated_at"> & {
  stages: StageDetail[];
};

export type RunDiagnosisSession = OperatorFields<Operator.OperatorRunDiagnosisSession,
  "session_id" | "stage_key" | "cohort_id" | "cohort_key" | "worker" | "execution_id" | "action_point" | "is_current" | "status">;

export interface RunDiagnosisGate extends ParkedGate { cohort_id: string | null }

export type PullRequestMergeWait = OperatorFields<Operator.OperatorPullRequestMergeWait,
  "cohort_id" | "stage_instance_id" | "unit_id" | "pull_request_url">;

export type RunDiagnosisArtifact = OperatorFields<Operator.OperatorRunDiagnosisArtifact,
  "artifact_id" | "type_id" | "revision" | "stage_name" | "label" | "created_at">;

export type RunDiagnosis = {
  run: RunDetail;
  sessions: RunDiagnosisSession[];
  current_session: RunDiagnosisSession | null;
  sessions_awaiting_action: RunDiagnosisSession[];
  active_gates: RunDiagnosisGate[];
  pull_request_merge_waits: PullRequestMergeWait[];
  recent_artifacts: RunDiagnosisArtifact[];
  stage_progress: Record<CoreStatus, number> & { total: number };
};


/**
 * Where a session sits in the run graph, mirroring
 * `OperatorSessionRunLocation` (`oakridge-dbos/src/domain/operator-projections.ts`)
 * — `GET /sessions/:session_id/run`.
 *
 * Unconditional by design: this answers navigation, which stays true after the
 * work order finished and its cleanup completed. It is not a session *hold*,
 * which answers whether the session is safe to close.
 */
export type SessionRunLocation = OperatorFields<Operator.OperatorSessionRunLocation,
  "stage_instance_id" | "stage_key" | "unit_id" | "work_order_id"> & {
  run_id: WorkflowRunId;
};

export type { ArtifactRevision, ArtifactRevisionStatus, FindingSeverity, AssessmentVerdict, PrReviewStatus, ArtifactCapabilities, ArtifactReviewDescriptor, ArtifactTypeDescriptor, ArtifactDetail } from "./artifact-types";

export type ParkedGate = OperatorFields<Operator.OperatorParkedGate,
  "id" | "stage_instance_id" | "gate_type" | "gate_step" | "run_id" | "stage_name" | "unit_id" | "artifact_revision_id" | "worktree" | "resume_actions" | "run_state" | "actionable",
  "artifact_revision_ids" | "pr_url"> & {
  repository_key?: RepositoryKey | null;
};

export type CohortLifecycle = CoreStatus;

export interface CohortCompletion {
  build_complete: boolean;
  assessment_complete: boolean;
}

export type CohortLifecycleSummary = OperatorFields<Operator.OperatorCohortSummary,
  "id" | "run_id" | "workflow_name" | "stage_instance_id" | "stage_name" | "unit_id" | "lifecycle" | "blocked_reason" | "next_actor" | "completion" | "blocked_by" | "updated_at",
  "title" | "artifact_revision_id" | "artifact_url" | "gate_id" | "gate_url" | "links" | "facts"> & {
  repository_key?: RepositoryKey | null;
  artifact_revision_ids?: string[];
  pr_url?: string | null;
  pull_request_reconciliation?: CohortPullRequestReconciliation | null;
};

export type ReviewInboxItemKind =
  | "artifact_gate"
  | "merge_confirmation"
  | "cohort_blocked"
  | "cohort_failed"
  | "cohort_retry"
  | "pull_request_mismatch"
  | "pull_request_merge";

export type ReviewInboxItemState = "actionable" | "blocked";

export type ReviewInboxItem = OperatorFields<Operator.OperatorReviewInboxItem,
  "id" | "kind" | "state" | "run_id" | "workflow_name" | "stage_instance_id" | "stage_name" | "unit_id" | "lifecycle" | "blocked_reason" | "next_actor" | "resume_actions" | "blocked_by",
  "title" | "artifact_revision_id" | "artifact_revision_ids" | "artifact_url" | "gate_id" | "gate_url" | "pr_url"> & {
  repository_key?: RepositoryKey | null;
};

/** The items list is the required-attention decision queue; completed and optional-attention history lives outside the inbox. */
export type ReviewInbox = {
  cohorts: CohortLifecycleSummary[];
  items: ReviewInboxItem[];
  attention_count: number;
};

export interface PullRequestObservation {
  owner: string;
  name: string;
  number: number;
  url: string;
  head_branch: string;
  base_branch: string;
  state: "open" | "merged" | "closed_unmerged";
  observed_at: string;
}

export interface PullRequestMismatch {
  kind: "missing_repository_identity" | "repository_mismatch" | "pull_request_mismatch" | "head_branch_mismatch" | "base_branch_mismatch" | "closed_without_merge" | "stale_observation";
  detail: string;
}

export interface CohortPullRequestReconciliation {
  repository_key: RepositoryKey;
  observation: PullRequestObservation;
  mismatch: PullRequestMismatch | null;
  completed_at: string | null;
  updated_at: string;
}

// ── Collab types ──────────────────────────────────────────────────────────────

export interface CollabMessage {
  id: string;
  thread_id: string;
  body: string;
  author: string;
  created_at: string;
}

export interface CollabThread {
  id: string;
  artifact_id: string;
  revision_id: string;
  anchor: string | null;
  status: "open" | "resolved";
  created_at: string;
  messages: CollabMessage[];
}

export interface PostThreadRequest {
  anchor?: string | null;
  body: string;
  author: string;
}

export interface PostMessageRequest {
  body: string;
  author: string;
}

export type { SessionMessageParty, SessionMessageRecord, PostSessionMessageRequest, SessionMessageAccepted } from "./session-message-types";

export interface PostAtomEditRequest {
  anchor: string;
  prev_value: unknown;
  new_value: unknown;
  author: string;
}

// ── Workflow-def authoring types ──────────────────────────────────────────────
// Mirror the oakridge-dbos workflow-definition contract so form output matches what
// POST /workflow_defs and GET /workflow_defs/:id round-trip.

export interface WorkflowDefFull {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly definition: WorkflowDefinitionDescriptor;
  readonly archived: boolean;
  readonly created_at: string;
}
export type WorkflowDefInput = WorkflowDefinitionDescriptor;
