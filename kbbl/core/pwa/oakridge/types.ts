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
  definition?: import("../../../../oakridge-dbos/src/domain/dev-flow-v15").WorkflowDefinition;
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
  planner: import("../../../../oakridge-dbos/src/domain/dev-flow-v15").AgentSettings;
  builder: import("../../../../oakridge-dbos/src/domain/dev-flow-v15").AgentSettings;
}

export type RepositoryKey = string & { readonly __brand: "RepositoryKey" };
export type CohortId = string & { readonly __brand: "CohortId" };
export type WorkflowRunId = string & { readonly __brand: "WorkflowRunId" };
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type RunEventEffect =
  | { readonly kind: "none" | "deliver_message" | "resume_wait" }
  | { readonly kind: "start_stage"; readonly stage_instance_id: string }
  | { readonly kind: "worker_decision"; readonly cohort_id: string; readonly from_state: string; readonly to_state: string;
      readonly changes: readonly import("../../../../oakridge-dbos/src/domain/dev-flow-v15").V15Change[];
      readonly actions: readonly { readonly worker: import("../../../../oakridge-dbos/src/domain/dev-flow-v15").V15WorkerKey; readonly action_point: string }[] }
  | { readonly kind: "cohort_transition"; readonly cohort_id: string; readonly unit_label: string;
      readonly event_kind: string; readonly from_state: string; readonly to_state: string;
      readonly next_actor: string | null; readonly refusal: null }
  | { readonly kind: "pull_request_observed" | "pull_request_merge_confirmed"; readonly repository_key: string; readonly pull_request_url: string; readonly state: string; readonly source: string; readonly merged_at: string | null }
  | { readonly kind: "unrecognized"; readonly effect_kind: string };

/** Mirrors the v15 run transition projection in oakridge-dbos/src/domain/run-event.ts. */
export interface RunEvent {
  readonly sequence: string;
  readonly transition_id: string;
  readonly run_id: WorkflowRunId;
  readonly owner: { readonly kind: "run" | "stage_instance" | "cohort"; readonly id: string };
  readonly launch_reason: "initial" | "dependency_satisfied" | "artifact_accepted" | "gate_decided" | "operator" | "retry" | "recovery";
  readonly prior_owner_version: number;
  readonly resulting_owner_version: number;
  readonly effect: RunEventEffect;
  readonly effect_workflow_id: string | null;
  readonly actor: string;
  readonly occurred_at: string;
}

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

export type CoreStatus = "pending" | "active" | "blocked" | "complete" | "failed" | "cancelled";
export type BlockedReason = "dependency" | "gate" | "capacity" | "external" | "operator" | "retry";
export type NextActor = "core" | "agent" | "service" | "operator" | "external";
export type RunStatus = CoreStatus;
export type RunDisplayStatus = RunStatus;

/** The run's committed lifecycle status carried on a gate row. */
export type RunState = CoreStatus;

export interface RunSummary {
  id: string;
  title: string | null;
  repository_keys: string[];
  workflow_name: string;
  status: RunStatus;
  blocked_reason: BlockedReason | null;
  next_actor: NextActor | null;
  current_stage: string | null;
  stage_total: number;
  stage_complete: number;
  attention_count: number;
  parked_count: number;
  updated_at: string;
  archived?: boolean;
}

export interface WorktreeMetadata {
  branch: string;
  path: string;
  base_ref: string;
}

export type StageStatus = CoreStatus;
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
  version: number;
  workers: readonly import("../../../../oakridge-dbos/src/domain/operator-projections").OperatorWorkerRecord[];
  cohort_id: string;
  unit_id: string;
  state?: string;
  repository_key?: RepositoryKey | null;
  brief: import("../../../../oakridge-dbos/src/domain/dev-flow-artifacts").BuildBriefBody | null;
  sid: string | null;
  worktree: WorktreeMetadata | null;
  base_sha?: string | null;
  status: StageStatus;
  blocked_reason: BlockedReason | null;
  next_actor: NextActor | null;
  retryable: boolean;
  gate: string | null;
}

export interface StageDetail {
  stage_instance_id: string;
  name: string;
  type: string;
  status: StageStatus;
  blocked_reason: BlockedReason | null;
  next_actor: NextActor | null;
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
  blocked_reason: BlockedReason | null;
  next_actor: NextActor | null;
  stages: StageDetail[];
  parked_count: number;
  updated_at: string;
}

export interface RunDiagnosisSession {
  session_id: string;
  stage_key: string;
  cohort_id: string;
  cohort_key: string;
  worker: import("../../../../oakridge-dbos/src/domain/dev-flow-v15").V15WorkerKey;
  execution_id: string;
  action_point: string;
  is_current: boolean;
  status: CoreStatus;
}

export interface RunDiagnosisGate extends ParkedGate { cohort_id: string | null }

export interface PullRequestMergeWait {
  cohort_id: string;
  stage_instance_id: string;
  unit_id: string;
  pull_request_url: string;
}

export interface RunDiagnosisArtifact {
  artifact_id: string;
  type_id: string;
  revision: number;
  stage_name: string;
  label: string | null;
  created_at: string;
}

export interface RunDiagnosis {
  run: RunDetail;
  sessions: RunDiagnosisSession[];
  current_session: RunDiagnosisSession | null;
  sessions_awaiting_action: RunDiagnosisSession[];
  active_gates: RunDiagnosisGate[];
  pull_request_merge_waits: PullRequestMergeWait[];
  recent_artifacts: RunDiagnosisArtifact[];
  stage_progress: Record<CoreStatus, number> & { total: number };
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

export type { ArtifactRevision, ArtifactRevisionStatus, FindingSeverity, AssessmentVerdict, PrReviewStatus, ArtifactCapabilities, ArtifactReviewDescriptor, ArtifactTypeDescriptor, ArtifactDetail } from "./artifact-types";

export interface ParkedGate {
  id: string;
  stage_instance_id: string | null;
  gate_type: string;
  gate_step: string | null;
  run_id: string;
  stage_name: string;
  unit_id: string;
  repository_key?: RepositoryKey | null;
  artifact_revision_id: string | null;
  artifact_revision_ids?: string[];
  worktree: WorktreeMetadata | null;
  resume_actions: string[];
  pr_url?: string | null;
  /** The run's persisted state at read time — a gate stays listed whatever it is. */
  run_state: RunState;
  /** Whether a decision on this gate can still take effect. `false` means the run moved on (or ended) while the gate sat open — render it stranded. */
  actionable: boolean;
}

/**
 * The operator confirming a cohort's pull request merged, when Oakridge cannot
 * see the repository for itself. Mirrors the `operator_confirmation` half of
 * `POST /cohorts/:cohortId/pull_request` in oakridge-dbos.
 */
export type CohortPullRequestOutcomeKind =
  | "completed"
  | "already_completed"
  | "waiting"
  | "ignored_stale";

export interface CohortPullRequestResponse { state: string }

export type CohortLifecycle = CoreStatus;

export interface CohortCompletion {
  build_complete: boolean;
  assessment_complete: boolean;
}

export interface CohortLifecycleSummary {
  id: string;
  run_id: string;
  workflow_name: string;
  stage_instance_id: string;
  stage_name: string;
  unit_id: string;
  repository_key?: RepositoryKey | null;
  title?: string | null;
  lifecycle: CohortLifecycle;
  blocked_reason: BlockedReason | null;
  next_actor: NextActor | null;
  completion: CohortCompletion;
  blocked_by: string[];
  artifact_revision_id?: string | null;
  artifact_revision_ids?: string[];
  artifact_url?: string | null;
  gate_id?: string | null;
  gate_url?: string | null;
  links?: Array<{ key: string; label: string; url: string }>;
  facts?: Array<{ key: string; label: string; value: string }>;
  pr_url?: string | null;
  pull_request_reconciliation?: CohortPullRequestReconciliation | null;
  updated_at: string;
}

export type ReviewInboxItemKind =
  | "artifact_gate"
  | "merge_confirmation"
  | "cohort_blocked"
  | "cohort_failed"
  | "cohort_retry"
  | "pull_request_mismatch"
  | "pull_request_merge";

export type ReviewInboxItemState = "actionable" | "blocked";

export interface ReviewInboxItem {
  id: string;
  kind: ReviewInboxItemKind;
  state: ReviewInboxItemState;
  run_id: string;
  workflow_name: string;
  stage_instance_id: string;
  stage_name: string;
  unit_id: string;
  repository_key?: RepositoryKey | null;
  lifecycle: CohortLifecycle;
  blocked_reason: BlockedReason | null;
  next_actor: NextActor | null;
  title?: string | null;
  artifact_revision_id?: string | null;
  artifact_revision_ids?: string[];
  artifact_url?: string | null;
  gate_id?: string | null;
  gate_url?: string | null;
  resume_actions: string[];
  blocked_by: string[];
  pr_url?: string | null;
}

/** The items list is the required-attention decision queue; completed and optional-attention history lives outside the inbox. */
export interface ReviewInbox {
  cohorts: CohortLifecycleSummary[];
  items: ReviewInboxItem[];
  attention_count: number;
}

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
  readonly definition: import("../../../../oakridge-dbos/src/domain/dev-flow-v15").WorkflowDefinition;
  readonly archived: boolean;
  readonly created_at: string;
}
export type WorkflowDefInput = import("../../../../oakridge-dbos/src/domain/dev-flow-v15").WorkflowDefinition;
