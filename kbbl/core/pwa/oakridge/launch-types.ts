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

export interface CreateRunRequest {
  readonly workflow_def_id: string;
  readonly project_id: string | null;
  readonly workflow_input: Readonly<Record<string, unknown>>;
  readonly session_settings: CreateRunContext["session_settings"];
  readonly grading_enabled: boolean;
}
