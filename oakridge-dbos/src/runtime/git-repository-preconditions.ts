import type {
  RepositoryPrecondition,
  RepositoryPreconditionChecker,
  RepositoryPreconditionFailure,
} from "../domain/repository-preconditions";

/**
 * Bounded so a wedged or network-backed repository cannot hold a launch open.
 * Matches the budget `project-identity` uses for the same kind of local read.
 */
const GIT_TIMEOUT_MS = 2_000;

/** Whether a git command succeeded, run against a repository directory. */
const gitSucceeds = async (repoDir: string, args: readonly string[]): Promise<boolean> => {
  const process = Bun.spawn(["git", "-C", repoDir, ...args], { stdout: "ignore", stderr: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; process.kill(); }, GIT_TIMEOUT_MS);
  try {
    const exitCode = await process.exited;
    return !timedOut && exitCode === 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

export class GitRepositoryPreconditionChecker implements RepositoryPreconditionChecker {
  constructor(private readonly git_succeeds: (repo_dir: string, args: readonly string[]) => Promise<boolean> = gitSucceeds) {}

  async check(repositories: readonly RepositoryPrecondition[]): Promise<readonly RepositoryPreconditionFailure[]> {
    const failures: RepositoryPreconditionFailure[] = [];
    for (const repository of repositories) {
      const isRepository = await this.git_succeeds(repository.repository_path, ["rev-parse", "--git-dir"]);
      if (!isRepository) {
        // Nothing else is answerable once this fails, and reporting a missing
        // branch for a directory that is not a repository would misdirect.
        failures.push({ kind: "not_a_git_repository", repository_key: repository.repository_key, repository_path: repository.repository_path });
        continue;
      }
      // `--verify <ref>^{commit}` is exactly how kbbl's worktree creation
      // resolves a base ref, so a launch that passes here agrees with the
      // code that will later depend on it.
      for (const [role, ref, createFrom] of [
        ["base_branch", repository.base_branch, null],
        ["epic_branch", repository.epic_branch, repository.base_branch],
      ] as const) {
        const exists = await this.git_succeeds(repository.repository_path, ["rev-parse", "--verify", `${ref}^{commit}`]);
        if (!exists) {
          failures.push({ kind: "missing_ref", repository_key: repository.repository_key, repository_path: repository.repository_path, role, ref, create_from: createFrom });
        }
      }
    }
    return failures;
  }
}
