import type { RepositoryInput } from "./types";

export type RepositoryInputResult =
  | { ok: true; repositories: RepositoryInput[] }
  | { ok: false; error: string };

export function validateRepositoryInputs(inputs: RepositoryInput[]): RepositoryInputResult {
  const repositories = inputs.map((repository) => ({
    key: repository.key.trim(),
    path: repository.path.trim(),
  }));
  if (repositories.length === 0) {
    return { ok: false, error: "Add at least one repository." };
  }
  if (repositories.some((repository) => !repository.key || !repository.path)) {
    return { ok: false, error: "Every repository needs a key and path." };
  }
  if (repositories.some((repository) => !repository.path.startsWith("/"))) {
    return { ok: false, error: "Repository paths must be absolute." };
  }
  if (new Set(repositories.map((repository) => repository.key)).size !== repositories.length) {
    return { ok: false, error: "Repository keys must be unique." };
  }
  return { ok: true, repositories };
}
