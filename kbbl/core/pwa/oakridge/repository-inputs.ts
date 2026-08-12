import type { Project, RepositoryInput, RepositoryInputDraft, RepositoryKey } from "./types";

export function repositoryDraftFromProject(
  project: Project,
  current: RepositoryInputDraft,
): RepositoryInputDraft {
  const key = project.name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "repo";
  return {
    ...current,
    key,
    path: project.repo_dir,
    forge_owner: project.forge_repository?.owner ?? current.forge_owner,
    forge_name: project.forge_repository?.name ?? current.forge_name,
    base_branch: project.base_branch ?? current.base_branch,
  };
}

export interface RepositoryInputError {
  operation: "validate_repository_inputs";
  repository: number | RepositoryKey | null;
  detail: string;
}

export interface ValidatedRepositoryInput extends RepositoryInput {
  forge_owner: string;
  forge_name: string;
  base_branch: string;
}

export type RepositoryInputResult =
  | { ok: true; repositories: ValidatedRepositoryInput[] }
  | { ok: false; error: RepositoryInputError };

function repositoryError(
  repository: number | RepositoryKey | null,
  detail: string,
): RepositoryInputResult {
  return { ok: false, error: { operation: "validate_repository_inputs", repository, detail } };
}

export function parseRepositoryKey(value: string): RepositoryKey | null {
  const key = value.trim();
  return key.length > 0 ? key as RepositoryKey : null;
}

export function validateRepositoryInputs(inputs: RepositoryInputDraft[]): RepositoryInputResult {
  const repositories = inputs.map((repository) => ({
    key: parseRepositoryKey(repository.key),
    path: repository.path.trim(),
    forge_owner: repository.forge_owner.trim(),
    forge_name: repository.forge_name.trim(),
    base_branch: repository.base_branch.trim(),
  }));
  if (repositories.length === 0) {
    return repositoryError(null, "Add at least one repository.");
  }
  const incompleteIndex = repositories.findIndex((repository) => !repository.key || !repository.path || !repository.forge_owner || !repository.forge_name || !repository.base_branch);
  if (incompleteIndex !== -1) {
    return repositoryError(incompleteIndex, "Every repository needs a key, local path, GitHub owner/name, and base branch.");
  }
  const relativeIndex = repositories.findIndex((repository) => !repository.path.startsWith("/"));
  if (relativeIndex !== -1) {
    return repositoryError(relativeIndex, "Repository paths must be absolute.");
  }
  if (new Set(repositories.map((repository) => repository.key)).size !== repositories.length) {
    const duplicate = repositories.find((repository, index) =>
      repositories.findIndex((candidate) => candidate.key === repository.key) !== index
    );
    return repositoryError(duplicate?.key ?? null, "Repository keys must be unique.");
  }
  return { ok: true, repositories: repositories as ValidatedRepositoryInput[] };
}
