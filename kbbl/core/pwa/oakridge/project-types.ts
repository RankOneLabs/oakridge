// Oakridge projects, workflow definition summaries and run launch settings.

import type { RuntimeId } from "../../runtime";
import type { ForgeRepositoryIdentity, RepositoryInput } from "./run-types";
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
  base_branch?: string | null;
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
  readonly id: string;
  readonly name: string;
}

/** One agent worker's launch choice, mirroring OperatorSessionSettings. */
export interface LaunchSessionSettings {
  readonly harness: RuntimeId;
  readonly model: string;
  readonly effort: string | null;
}

// Each declared agent worker receives its own runtime, model and effort.
export interface CreateRunContext {
  brief_notes: string;
  /** The one branch this run builds on. Every build unit's PR targets it. */
  base_branch: string;
  repositories: RepositoryInput[];
  // Compatibility input for workflow definitions older than dev-flow v2.
  worktree_path: string;
  oakridge_url: string;
  session_settings: Readonly<{ [stage: string]: Readonly<{ [worker: string]: LaunchSessionSettings }> }>;
}
