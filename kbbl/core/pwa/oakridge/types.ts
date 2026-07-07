// View-model types for the oakridge operator surface.
// These are typed at the PWA boundary — they do not copy oakridge-core
// internal Rust domain models wholesale but cover what the UI needs.

export interface OakridgeConfig {
  available: boolean;
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
}

export interface StageDetail {
  name: string;
  type: string;
  status: StageStatus;
  artifacts: StageArtifact[];
  delegated_kbbl_sid: string | null;
  worktree: WorktreeMetadata | null;
}

export interface RunDetail {
  id: string;
  workflow_name: string;
  status: RunStatus;
  stages: StageDetail[];
  parked_count: number;
  updated_at: string;
}

export interface ArtifactRevision {
  id: string;
  status: "draft" | "approved" | "rejected";
  created_at: string;
  body: unknown;
  validation: unknown;
}

export interface ArtifactDetail {
  id: string;
  type_id: string;
  run_id: string;
  producing_stage: string;
  revisions: ArtifactRevision[];
}

export interface ParkedGate {
  id: string;
  gate_type: string;
  run_id: string;
  stage_name: string;
  artifact_revision_id: string | null;
  worktree: WorktreeMetadata | null;
  resume_actions: string[];
}

export interface GateResumeRequest {
  action: string;
  operator_comment: string;
  feedback: string;
}

export interface GateResumeResponse {
  gate_id: string;
  resumed: boolean;
}
