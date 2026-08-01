import type { RepositoryInput, RepositoryInputDraft, RepositoryKey } from "./types";

export interface RepositoryInputError {
  operation: "validate_repository_inputs";
  repository: number | RepositoryKey | null;
  detail: string;
}

export type RepositoryInputResult =
  | { ok: true; repositories: RepositoryInput[] }
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
  }));
  if (repositories.length === 0) {
    return repositoryError(null, "Add at least one repository.");
  }
  const incompleteIndex = repositories.findIndex((repository) => !repository.key || !repository.path);
  if (incompleteIndex !== -1) {
    return repositoryError(incompleteIndex, "Every repository needs a key and path.");
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
  return { ok: true, repositories: repositories as RepositoryInput[] };
}
