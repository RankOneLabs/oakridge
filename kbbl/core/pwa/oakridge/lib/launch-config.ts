import type { RuntimeModelSelection } from "../../types";
import type { CreateRunContext, EpicProfileConfig, FinalMergePolicy, RepositoryInput } from "../types";
import type { ValidatedRepositoryInput } from "../repository-inputs";

export interface BuildRunExecutionContextInput {
  readonly brief_notes: string;
  readonly repositories: RepositoryInput[];
  readonly oakridge_url: string;
  readonly planner: RuntimeModelSelection;
  readonly worker: RuntimeModelSelection;
}

export function buildRunExecutionContext(input: BuildRunExecutionContextInput): CreateRunContext {
  return {
    brief_notes: input.brief_notes,
    repositories: input.repositories,
    worktree_path: input.repositories[0]?.path ?? "",
    oakridge_url: input.oakridge_url,
    planner_runtime: input.planner.runtime,
    planner_model: input.planner.model,
    planner_effort: input.planner.effort ?? null,
    worker_runtime: input.worker.runtime,
    worker_model: input.worker.model,
    worker_effort: input.worker.effort ?? null,
  };
}

export function epicSlugFromTitle(title: string): string | null {
  const slug = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug || null;
}

export function buildEpicProfile(title: string, finalMergePolicy: FinalMergePolicy, repositories: ValidatedRepositoryInput[]): EpicProfileConfig | null {
  const normalizedTitle = title.trim();
  const slug = epicSlugFromTitle(normalizedTitle);
  if (!normalizedTitle || !slug) return null;
  return {
    title: normalizedTitle,
    slug,
    final_merge_policy: finalMergePolicy,
    repositories: repositories.map((repository) => ({
      repository_key: repository.key,
      repository_path: repository.path,
      base_branch: repository.base_branch,
      forge_repository: {
        provider: "github",
        owner: repository.forge_owner,
        name: repository.forge_name,
      },
    })),
  };
}
