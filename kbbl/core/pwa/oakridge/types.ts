// View-model types for the oakridge operator surface.
// These are typed at the PWA boundary — they do not copy oakridge-core
// internal Rust domain models wholesale but cover what the UI needs.

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
  repositories: RepositoryInput[];
  // Compatibility input for workflow definitions older than dev-flow v2.
  worktree_path: string;
  oakridge_url: string;
  planner_runtime: RuntimeId;
  planner_model: string;
  planner_effort?: string;
  worker_runtime: RuntimeId;
  worker_model: string;
  worker_effort?: string;
}

export type RepositoryKey = string & { readonly __brand: "RepositoryKey" };

export interface RepositoryInputDraft {
  key: string;
  path: string;
}

export interface RepositoryInput {
  key: RepositoryKey;
  path: string;
}

export interface CreateRunRequest {
  workflow_def_id: string;
  project_id: string | null;
  context: CreateRunContext;
}

export type RunStatus = "running" | "parked" | "failed" | "complete" | "cancelled";

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
  run_id: string;
  stage_name: string;
  unit_id: string;
  repository_key?: RepositoryKey | null;
  artifact_revision_id: string | null;
  gate_step?: string;
  worktree: WorktreeMetadata | null;
  resume_actions: string[];
  pr_url?: string | null;
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

export type SlotBindingSource = "input" | "context" | "literal" | "item" | "context_lookup";

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
    };

// Bindable: a bare string literal OR a SlotBinding (Rust #[serde(untagged)])
export type Bindable = string | SlotBinding;

export interface WorktreeTemplate {
  branch_name: string;
  worktree_subdir: string;
  base_ref?: string | null;
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
