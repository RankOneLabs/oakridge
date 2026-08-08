import type { EpicProfileConfig } from "../types";
import type { ValidatedRepositoryInput } from "../repository-inputs";

export function epicSlugFromTitle(title: string): string | null {
  const slug = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug || null;
}

export function buildEpicProfile(title: string, repositories: ValidatedRepositoryInput[]): EpicProfileConfig | null {
  const normalizedTitle = title.trim();
  const slug = epicSlugFromTitle(normalizedTitle);
  if (!normalizedTitle || !slug) return null;
  return {
    title: normalizedTitle,
    slug,
    final_merge_policy: "guarded",
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
