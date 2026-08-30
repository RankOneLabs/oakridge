// View-model types for the oakridge operator surface.
// These are typed at the PWA boundary and cover what the operator UI needs.

import type { RuntimeId } from "../../runtime";

export interface OakridgeConfig {
  available: boolean;
  core_url?: string | null;
}

export interface Project {
  id: string;
  name: string;
  repo_dir: string;
  created_at: string;
  forge_repository?: ForgeRepositoryIdentity | null;
  base_branch?: string | null;
}

export interface WorkflowDefSummary {
  id: string;
  name: string;
  version: number;
  // Retired from the launcher. The def still resolves for the runs that used it.
  archived?: boolean;
  // GET /workflow_defs returns the full def today; keep this optional for a
  // future trimmed summary response.
  graph?: WorkflowGraph;
}

// Each role ships runtime, model, and effort together. A model is only valid
// against the runtime it was chosen from, so sending a model without its runtime
// is what let a codex planner model reach a claude-code-pinned stage.
export interface CreateRunContext {
  brief_notes: string;
  /** The one branch this run builds on. Every build unit's PR targets it. */
  base_branch: string;
  repositories: RepositoryInput[];
  // Compatibility input for workflow definitions older than dev-flow v2.
  worktree_path: string;
  oakridge_url: string;
  planner_runtime: RuntimeId;
  planner_model: string;
  planner_effort: string | null;
  worker_runtime: RuntimeId;
  worker_model: string;
  worker_effort: string | null;
}

export type RepositoryKey = string & { readonly __brand: "RepositoryKey" };
export type CohortId = string & { readonly __brand: "CohortId" };
export type EpicProfileId = string & { readonly __brand: "EpicProfileId" };
export type WorkflowRunId = string & { readonly __brand: "WorkflowRunId" };

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

export interface AdmitStageUnitResponse {
  stage_instance_id: string;
  unit_id: string;
  admitted: boolean;
}

export interface CreateRunRequest {
  workflow_def_id: string;
  project_id: string | null;
  context: CreateRunContext;
  epic_profile: EpicProfileConfig;
}

export type RunStatus = "pending" | "running" | "parked" | "failed" | "complete" | "cancelled";

/** The run's own persisted lifecycle state, distinct from the derived `RunStatus` above — carried on a gate row so a stranded gate can say what happened to its run. */
export type RunState = "active" | "succeeded" | "failed" | "cancelled";

export interface RunSummary {
  id: string;
  workflow_name: string;
  status: RunStatus;
  current_stage: string | null;
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

export interface StageArtifact {
  id: string;
  type_id: string;
  version: number;
  label?: string | null;
}

export interface StageUnit {
  unit_id: string;
  repository_key?: RepositoryKey | null;
  params?: CohortBriefParams | null;
  sid: string | null;
  worktree: WorktreeMetadata | null;
  base_sha?: string | null;
  status: StageStatus;
  gate: string | null;
  admission_required?: boolean;
  admitted?: boolean;
  admission_eligible?: boolean;
  admission_blocked_by?: string[];
}

/** The operator-facing subset of the persisted fan-out item contract. */
export interface CohortBriefParams {
  title?: string;
  scope?: string;
  description?: string;
  files_in_scope?: string[];
  decisions?: string[];
  acceptance_criteria?: string[];
  depends_on?: string[];
  repository_key?: RepositoryKey | string;
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
  workflow_name: string;
  status: RunStatus;
  stages: StageDetail[];
  parked_count: number;
  updated_at: string;
  is_stuck: boolean;
  epic_profile?: EpicWorkflowProfile | null;
}

export interface ArtifactRevision {
  id: string;
  status: "draft" | "approved" | "rejected";
  created_at: string;
  body: unknown;
  validation: unknown;
}

export interface ArtifactCapabilities {
  reviewable: boolean;
  commentable: boolean;
  atom_editable: boolean;
  review_items: boolean;
}

export interface ArtifactReviewDescriptor {
  viewer: string;
  layout: "document" | "dag" | "report";
  sections: string[];
  action_labels: Record<string, string>;
}

export interface ArtifactTypeDescriptor {
  id: string;
  component_id: string;
  capabilities: ArtifactCapabilities;
  anchor_schema: string[] | null;
  review?: ArtifactReviewDescriptor | null;
}

export interface ArtifactDetail {
  id: string;
  type_id: string;
  component_id: string | null;
  capabilities: ArtifactCapabilities | null;
  anchor_schema: string[] | null;
  review?: ArtifactReviewDescriptor | null;
  run_id: string;
  producing_stage: string;
  label?: string | null;
  revisions: ArtifactRevision[];
}

export interface ParkedGate {
  id: string;
  gate_type: string;
  gate_step: string | null;
  run_id: string;
  stage_name: string;
  unit_id: string;
  repository_key?: RepositoryKey | null;
  artifact_revision_id: string | null;
  worktree: WorktreeMetadata | null;
  resume_actions: string[];
  pr_url?: string | null;
  /** The run's persisted state at read time — a gate stays listed whatever it is. */
  run_state: RunState;
  /** Whether a decision on this gate can still take effect. `false` means the run moved on (or ended) while the gate sat open — render it stranded. */
  actionable: boolean;
}

export interface GateResumeRequest {
  idempotency_key: string;
  artifact_revision_id: string;
  gate_step: string;
  action: string;
  operator_comment: string;
  feedback: string;
}

export interface GateResumeResponse {
  gate_id: string;
  resumed: boolean;
}

/**
 * The operator confirming a cohort's pull request merged, when Oakridge cannot
 * see the repository for itself. Mirrors the `operator_confirmation` half of
 * `POST /cohorts/:cohortId/pull_request` in oakridge-dbos.
 */
export interface ConfirmCohortMergedRequest {
  idempotency_key: string;
  operator_comment: string;
}

export type CohortPullRequestOutcomeKind =
  | "completed"
  | "already_completed"
  | "merged_not_awaiting"
  | "waiting"
  | "ignored_stale";

export interface CohortPullRequestResponse {
  cohort_id: string;
  outcome: { kind: CohortPullRequestOutcomeKind };
}

export type CohortLifecycle =
  | "waiting_admission"
  | "building"
  | "artifact_review"
  | "revision_requested"
  | "merge_confirmation"
  | "assessing"
  | "github_review"
  | "pull_request_mismatch"
  | "complete"
  | "failed";

export interface CohortCompletion {
  build_complete: boolean;
  assessment_complete: boolean;
}

export interface CohortAdmission {
  required: boolean;
  admitted: boolean;
  eligible: boolean;
  blocked_by: string[];
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
  completion: CohortCompletion;
  admission: CohortAdmission;
  artifact_revision_id?: string | null;
  artifact_url?: string | null;
  gate_id?: string | null;
  gate_url?: string | null;
  pr_url?: string | null;
  pull_request_reconciliation?: CohortPullRequestReconciliation | null;
  updated_at: string;
}

export type ReviewInboxItemKind =
  | "admission"
  | "artifact_gate"
  | "merge_confirmation"
  | "cohort_blocked"
  | "cohort_failed"
  | "pull_request_mismatch"
  | "pull_request_merge"
  | "gate_decision";

export type ReviewInboxItemState = "actionable" | "blocked" | "completed";

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
  title?: string | null;
  artifact_revision_id?: string | null;
  artifact_url?: string | null;
  gate_id?: string | null;
  gate_url?: string | null;
  resume_actions: string[];
  blocked_by: string[];
  pr_url?: string | null;
  completed_at?: string | null;
}

export interface ReviewInbox {
  cohorts: CohortLifecycleSummary[];
  items: ReviewInboxItem[];
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

export interface ReviewItem {
  id: string;
  artifact_id: string;
  revision_id: string;
  anchor: string;
  claim: string;
  reality: string;
  status: "open" | "resolved" | "waived";
  resolution: string | null;
  created_at: string;
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

export interface PostAtomEditRequest {
  anchor: string;
  prev_value: unknown;
  new_value: unknown;
  author: string;
}

export interface PostReviewItemRequest {
  anchor: string;
  claim: string;
  reality: string;
}

export interface PatchReviewItemRequest {
  status: "resolved" | "waived";
  resolution?: string;
}

// ── Workflow-def authoring types ──────────────────────────────────────────────
// Mirror the oakridge-core Rust schema so form output matches what
// POST /workflow_defs and GET /workflow_defs/:id round-trip.

export type SlotBindingSource =
  | "input"
  | "context"
  | "literal"
  | "item"
  | "context_lookup"
  | "input_lookup";

export type SlotBinding =
  | { from: "input"; input_name: string; path?: string | null }
  | { from: "context"; path: string }
  | { from: "literal"; value: string }
  | { from: "item"; path: string }
  | {
      from: "context_lookup";
      collection_path: string;
      collection_key_path: string;
      item_key_path: string;
      value_path: string;
    }
  // `context_lookup`'s sibling, keyed off a named input instead of the run
  // context. The seeded dev flow binds every cohort's expected PR base through
  // one of these; it was missing from this union, so the authoring UI could not
  // name the variant it was editing and replaced it on the first interaction.
  | {
      from: "input_lookup";
      input_name: string;
      collection_key_path: string;
      item_key_path: string;
      value_path: string;
    };

// Bindable: a bare string literal OR a SlotBinding (Rust #[serde(untagged)])
export type Bindable = string | SlotBinding;

export interface WorktreeTemplate {
  branch_name: string;
  worktree_subdir: string;
  // A `Bindable`, not a string: the seeded dev flow resolves a cohort's base ref
  // through an `input_lookup` on the provisioned repository refs. Typed as a
  // string here, it rendered as `[object Object]` in a text input and became one
  // the moment anyone typed in it.
  base_ref?: Bindable | null;
}

// camelCase: matches Rust #[serde(rename_all = "camelCase")] on WorktreeIdentity
export interface WorktreeIdentity {
  branchName: string;
  worktreeSubdir: string;
  baseRef?: string | null;
}

export interface FanOutConfig {
  over: SlotBinding;
  unit_id_path: string;
  depends_on_path?: string | null;
  max_parallel?: number;
  item_bindings?: Record<string, SlotBinding>;
  workdir?: SlotBinding | null;
  worktree?: WorktreeTemplate | null;
  inherit_worktree_from?: string | null;
}

export interface DelegatedSessionStageConfig {
  // Bindable like model/effort, but required: oakridge-core errors rather than
  // defaulting when a bound runtime resolves to nothing.
  runtime: Bindable;
  prompt_template_path: string;
  slot_bindings: Record<string, SlotBinding>;
  workdir: SlotBinding;
  session_name: string;
  model?: Bindable | null;
  effort?: Bindable | null;
  worktree?: WorktreeIdentity | null;
  pre_authorized_tools?: string[];
  yolo?: boolean;
  fan_out?: FanOutConfig | null;
  gate_output?: string | null;
}

export interface InputSlotDef {
  name: string;
  artifact_type: string;
  optional?: boolean;
  collect?: boolean;
  delivery?: "stage_complete" | "unit_complete";
}

export interface OutputSlotDef {
  name: string;
  artifact_type: string;
}

export interface StageNodeDef {
  stage_type: string;
  config: DelegatedSessionStageConfig;
  inputs: InputSlotDef[];
  outputs: OutputSlotDef[];
}

export interface EdgeEndpoint {
  stage: string;
  slot: string;
}

export interface EdgeDef {
  from: EdgeEndpoint;
  to: EdgeEndpoint;
}

export interface WorkflowGraph {
  stages: Record<string, StageNodeDef>;
  edges: EdgeDef[];
}

export interface WorkflowDefFull {
  id: string;
  name: string;
  version: number;
  graph: WorkflowGraph;
  created_at: string;
}

export interface WorkflowDefInput {
  name: string;
  version: number;
  graph: WorkflowGraph;
}
