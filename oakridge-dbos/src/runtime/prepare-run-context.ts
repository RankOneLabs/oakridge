import type { Project } from "../domain/projects";
import type { JsonValue } from "../domain/primitives";
import type { RunContext } from "../domain/run-context";
import type { CreateEpicProfileRequest } from "../domain/runs";
import { selectBaseBranch } from "../domain/repository-refs";

export interface PrepareRunContextInput {
  readonly caller_context: RunContext;
  readonly project: Project | null;
  readonly epic_profile: CreateEpicProfileRequest | null;
}

/**
 * The context a run actually launches with: what the caller sent, plus what the
 * project and epic configuration contribute.
 *
 * This is where the epic profile went. `oakridge.epic_workflow_profile` does not
 * exist in v15, and 0016's own comment records that the profile "is never
 * consulted by core" — it was launch configuration wearing a table. Four of its
 * fields were already written here; `forge_repository` and `final_merge_policy`
 * join them, so every stage reads epic configuration from the one place it
 * already reads `base_branch` and `repositories` from.
 *
 * `forge_repository` belongs on the repository entry rather than on the project
 * row: `oakridge.project.forge_repository` is one identity per project, which
 * cannot express a multi-repository epic. It has to stay launch configuration
 * and not an artifact, because it is the independent authority a candidate pull
 * request URL is checked against.
 *
 * Total, not fallible. The one shape check on the path — that a context is a
 * JSON object — belongs to the boundary that parses the request and lives there.
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
    title: epicProfile.title,
    slug: epicProfile.slug,
    // How the final epic pull request is allowed to complete. Read only by the
    // final-integration adapter (`selectFinalPullRequestStageConfig`); core
    // never looks at it.
    final_merge_policy: epicProfile.final_merge_policy,
    // The run's one base branch, beside the repositories rather than repeated
    // inside each of them: the provisioning stage guarantees this branch in
    // every repository, and every build unit targets it.
    base_branch: selectBaseBranch(epicProfile.base_branch, epicProfile.slug),
    repositories: epicProfile.repositories.map((repository): JsonValue => ({
      key: repository.repository_key,
      path: repository.repository_path,
      integration_branch: repository.integration_branch,
      forge_repository: repository.forge_repository === null
        ? null
        : { provider: repository.forge_repository.provider, owner: repository.forge_repository.owner,
          name: repository.forge_repository.name },
    })),
  };
};
