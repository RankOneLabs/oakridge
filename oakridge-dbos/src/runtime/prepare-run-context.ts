import type { Project } from "../domain/projects";
import type { JsonValue } from "../domain/primitives";
import type { RunContext } from "../domain/run-context";
import type { EpicWorkflowProfile, EpicWorkflowProfileId } from "../domain/epic";
import type { CreateEpicProfileRequest } from "../domain/runs";
import { selectBaseBranch } from "../domain/repository-refs";

export interface PrepareRunContextInput {
  readonly caller_context: RunContext;
  readonly project: Project | null;
  readonly epic_profile: CreateEpicProfileRequest | null;
}

export interface CreateEpicProfileInput {
  readonly id: EpicWorkflowProfileId;
  readonly workflow_run_id: EpicWorkflowProfile["workflow_run_id"];
  readonly config: CreateEpicProfileRequest;
  readonly created_at: string;
}

export const createEpicProfile = (input: CreateEpicProfileInput): EpicWorkflowProfile => ({
  id: input.id,
  workflow_run_id: input.workflow_run_id,
  title: input.config.title,
  slug: input.config.slug,
  lifecycle_state: "active",
  final_merge_policy: input.config.final_merge_policy,
  // One branch for the whole epic. It used to be per repository, so a two-repo
  // epic could carry two different names for the one thing every stage calls
  // "the base branch".
  base_branch: selectBaseBranch(input.config.base_branch, input.config.slug),
  repositories: input.config.repositories.map((repository) => ({
    repository_key: repository.repository_key,
    repository_path: repository.repository_path,
    integration_branch: repository.integration_branch,
    forge_repository: repository.forge_repository,
    final_pull_request: null,
    final_merge_state: "pending",
  })),
  created_at: input.created_at,
  updated_at: input.created_at,
});

/**
 * The context a run actually launches with: what the caller sent, plus what the
 * project and epic profile contribute.
 *
 * Total, not fallible. It used to refuse a caller context that was not a JSON
 * object — the only shape check anywhere on the path — but it could only do so
 * when a project or epic profile happened to be configured, so the same bad
 * context sailed through a plain launch. The check belongs to the boundary that
 * parses the request, and now lives there; by the time a context reaches this
 * transform it is a `RunContext` and there is nothing left to say no to.
 */
export const prepareRunContext = (input: PrepareRunContextInput): RunContext => {
  const projectContext: Record<string, JsonValue> = input.project
    ? {
        project: { id: input.project.id, name: input.project.name, repo_dir: input.project.repo_dir },
        workdir: input.project.repo_dir,
      }
    : {};
  const callerWins = { ...projectContext, ...input.caller_context };
  if (!input.epic_profile) return callerWins;
  const epicProfile = input.epic_profile;

  return {
    ...callerWins,
    // The run's one base branch, beside the repositories rather than repeated
    // inside each of them: the provisioning stage guarantees this branch in
    // every repository, and every build unit targets it.
    base_branch: selectBaseBranch(epicProfile.base_branch, epicProfile.slug),
    repositories: epicProfile.repositories.map((repository) => ({
      key: repository.repository_key,
      path: repository.repository_path,
      integration_branch: repository.integration_branch,
    })),
  };
};
