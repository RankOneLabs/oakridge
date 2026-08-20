import type { Brand, WorkflowRunId } from "./primitives";

export type EpicWorkflowProfileId = Brand<string, "EpicWorkflowProfileId">;
export type FinalMergePolicy = "guarded" | "external_confirmation";
export type EpicLifecycleState = "draft" | "active" | "final_integration" | "completed" | "failed";
export type FinalMergeState = "pending" | "pull_request_open" | "awaiting_confirmation" | "merged" | "closed_without_merge";
export interface PullRequestReference { readonly number: number; readonly url: string; readonly head_branch: string; readonly base_branch: string }
export interface ForgeRepositoryIdentity { readonly provider: "github"; readonly owner: string; readonly name: string }
export interface EpicRepositoryBinding { readonly repository_key: string; readonly repository_path: string; readonly integration_branch: string; readonly forge_repository: ForgeRepositoryIdentity | null; readonly final_pull_request: PullRequestReference | null; readonly final_merge_state: FinalMergeState }
/**
 * `base_branch` sits here rather than on each repository binding: an epic builds
 * on exactly one branch, materialized in every repository it touches.
 */
export interface EpicWorkflowProfile { readonly id: EpicWorkflowProfileId; readonly workflow_run_id: WorkflowRunId; readonly title: string; readonly slug: string; readonly lifecycle_state: EpicLifecycleState; readonly final_merge_policy: FinalMergePolicy; readonly base_branch: string; readonly repositories: readonly EpicRepositoryBinding[]; readonly created_at: string; readonly updated_at: string }
