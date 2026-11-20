import type { CreateRunContext } from "./project-types";
import type { FinalMergePolicy, ForgeRepositoryIdentity, RepositoryKey } from "./run-types";

/** What the New run form sends to start a run, before the launch adapter maps it to the workflow's input. */

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

export interface EpicRepositoryConfig {
  repository_key: RepositoryKey;
  repository_path: string;
  // Where this repository's base branch is cut from, and where its work merges
  // back — `main`, typically. The branch the run *builds on* is the epic's, one
  // for the whole run, and lives on EpicProfileConfig.
  integration_branch: string;
  forge_repository: ForgeRepositoryIdentity;
}

export interface EpicProfileConfig {
  title: string;
  slug: string;
  final_merge_policy: FinalMergePolicy;
  /** The one branch this epic builds on; the server defaults it to `epic/<slug>`. */
  base_branch?: string | null;
  repositories: EpicRepositoryConfig[];
}

/** Mirrors study's slice limits in workflow-config/study.yaml `input`: the most pilot-slice cases and the paid slice's cap. */
export interface StudySliceLimits {
  slice_case_limit: number;
  slice_cap_cents: number;
}
/** What the chosen workflow takes beyond the fields every launch shares. A study launched here never supplies `approved_plan`. */
export type WorkflowLaunchInput =
  | { kind: "development" }
  | { kind: "study"; slice: StudySliceLimits };

export interface CreateRunRequest {
  workflow_def_id: string;
  project_id: string | null;
  context: CreateRunContext;
  epic_profile: EpicProfileConfig;
  workflow_input: WorkflowLaunchInput;
}
