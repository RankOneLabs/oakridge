/**
 * What a run assumes about its repositories before it starts.
 *
 * Nothing creates the epic branch. `prepare-run-context` only *names* it
 * (`epic/${slug}`), and the first thing that needs it is the build stage,
 * which asks kbbl for a worktree based on it. A run therefore completed spec
 * analysis, planning and briefing — three agent sessions and three operator
 * approvals — before failing on a branch that was never going to exist, and
 * did so behind a generic session error.
 *
 * These are cheap local reads. Checking them at launch turns a late, opaque
 * failure into an immediate one that names the missing thing.
 */
export interface RepositoryPrecondition {
  readonly repository_key: string;
  readonly repository_path: string;
  readonly base_branch: string;
  readonly epic_branch: string;
}

/** Which branch a failure is about, so the message can say what it is for. */
export type RepositoryRefRole = "base_branch" | "epic_branch";

export type RepositoryPreconditionFailure =
  | { readonly kind: "not_a_git_repository"; readonly repository_key: string; readonly repository_path: string }
  | {
      readonly kind: "missing_ref";
      readonly repository_key: string;
      readonly repository_path: string;
      readonly role: RepositoryRefRole;
      readonly ref: string;
      /** The branch the missing one should be created from, when known. */
      readonly create_from: string | null;
    };

/** One actionable sentence per failure, naming the remedy rather than the symptom. */
export const describeRepositoryPreconditionFailure = (failure: RepositoryPreconditionFailure): string => {
  if (failure.kind === "not_a_git_repository") {
    return `repository '${failure.repository_key}' is not a git repository at ${failure.repository_path}`;
  }
  const role = failure.role === "epic_branch" ? "epic branch" : "base branch";
  const remedy = failure.create_from === null
    ? ""
    : ` — create it with: git -C ${failure.repository_path} branch ${failure.ref} origin/${failure.create_from}`;
  return `repository '${failure.repository_key}' has no ${role} '${failure.ref}' at ${failure.repository_path}${remedy}`;
};

/** Every failure across every repository, as one message. */
export const describeRepositoryPreconditionFailures = (failures: readonly RepositoryPreconditionFailure[]): string =>
  failures.map(describeRepositoryPreconditionFailure).join("; ");

/**
 * Resolves the refs a run needs. Injected so the launch path stays testable
 * without a git checkout on disk.
 */
export interface RepositoryPreconditionChecker {
  check(repositories: readonly RepositoryPrecondition[]): Promise<readonly RepositoryPreconditionFailure[]>;
}

/**
 * The repositories a prepared run context declares, or an empty list when the
 * run has no epic profile and therefore no repository assumptions to check.
 */
export const selectRepositoryPreconditions = (context: unknown): readonly RepositoryPrecondition[] => {
  if (typeof context !== "object" || context === null) return [];
  const repositories = (context as { readonly repositories?: unknown }).repositories;
  if (!Array.isArray(repositories)) return [];
  const preconditions: RepositoryPrecondition[] = [];
  for (const entry of repositories) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    const { key, path, base_branch, epic_branch } = candidate;
    if (typeof key !== "string" || typeof path !== "string" || typeof base_branch !== "string" || typeof epic_branch !== "string") continue;
    preconditions.push({ repository_key: key, repository_path: path, base_branch, epic_branch });
  }
  return preconditions;
};
