import { err, ok, type Result } from "./primitives";
import type { RepositoryRefs, RunContextRepository } from "./repository-refs";

/**
 * Guaranteeing that a repository has the refs a run assumes.
 *
 * Ported from v1's `ensureEpicBranchExists` (kbbl dispatcher), which v2 never
 * carried over — v2 named the epic branch, validated it, and consumed it, but
 * nothing created it. Four lessons are encoded in the order of the commands
 * below, and every one of them was learned from a failure:
 *
 * - `ls-remote` first, so an epic branch that already exists is never reseeded
 *   from the base branch and silently rewound.
 * - Seed from `origin/<base>` fetched under an explicit refspec, never from a
 *   local branch, so the epic branch cannot inherit a stale local checkout.
 * - A failed push is re-checked rather than reported: a concurrent seeder is a
 *   benign race, and the branch it created is the one we wanted.
 * - Finish with a local fetch, so `git rev-parse origin/<epic>` resolves later
 *   when the build stage cuts its worktree from it.
 *
 * The commands run through an injected runner: the sequencing is what has the
 * lessons in it, and it is worth testing without a checkout on disk.
 */

export interface GitCommandOutcome {
  readonly exit_code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one git command against a repository directory. Implemented at the IO edge. */
export interface GitCommandRunner {
  run(repository_path: string, args: readonly string[]): Promise<GitCommandOutcome>;
}

export type RepositoryProvisioningFailure =
  | { readonly kind: "not_a_git_repository"; readonly repository_key: string; readonly repository_path: string }
  | { readonly kind: "missing_base_branch"; readonly repository_key: string; readonly repository_path: string; readonly base_branch: string; readonly detail: string }
  | { readonly kind: "epic_branch_unavailable"; readonly repository_key: string; readonly repository_path: string; readonly epic_branch: string; readonly detail: string }
  | { readonly kind: "git_command_failed"; readonly repository_key: string; readonly repository_path: string; readonly command: string; readonly detail: string };

/** One actionable sentence per failure, naming the thing that is wrong rather than the symptom. */
export const describeRepositoryProvisioningFailure = (failure: RepositoryProvisioningFailure): string => {
  if (failure.kind === "not_a_git_repository") {
    return `repository '${failure.repository_key}' is not a git repository at ${failure.repository_path}`;
  }
  if (failure.kind === "missing_base_branch") {
    return `repository '${failure.repository_key}' has no base branch '${failure.base_branch}' on origin at ${failure.repository_path}: ${failure.detail}`;
  }
  if (failure.kind === "epic_branch_unavailable") {
    return `repository '${failure.repository_key}' could not publish epic branch '${failure.epic_branch}' to origin at ${failure.repository_path}: ${failure.detail}`;
  }
  return `repository '${failure.repository_key}' failed '${failure.command}' at ${failure.repository_path}: ${failure.detail}`;
};

const describeCommand = (args: readonly string[]): string => `git ${args.join(" ")}`;

/** The command's stderr, or its stdout when it said nothing there, so a failure is never blank. */
const outcomeDetail = (outcome: GitCommandOutcome): string =>
  outcome.stderr.trim() || outcome.stdout.trim() || `exited with code ${outcome.exit_code}`;

export const provisionRepositoryRefs = async (
  repository: RunContextRepository,
  git: GitCommandRunner,
): Promise<Result<RepositoryRefs, RepositoryProvisioningFailure>> => {
  const { key: repository_key, path: repository_path, base_branch, epic_branch } = repository;
  const commandFailure = (args: readonly string[], outcome: GitCommandOutcome): Result<never, RepositoryProvisioningFailure> =>
    err({ kind: "git_command_failed", repository_key, repository_path, command: describeCommand(args), detail: outcomeDetail(outcome) });

  const isRepository = await git.run(repository_path, ["rev-parse", "--git-dir"]);
  if (isRepository.exit_code !== 0) {
    // Nothing below is answerable once this fails, and reporting a missing
    // branch for a directory that is not a repository would misdirect.
    return err({ kind: "not_a_git_repository", repository_key, repository_path });
  }

  const epicRef = `refs/heads/${epic_branch}`;
  const lsRemoteArgs = ["ls-remote", "origin", epicRef] as const;
  const published = await git.run(repository_path, lsRemoteArgs);
  if (published.exit_code !== 0) return commandFailure(lsRemoteArgs, published);

  if (published.stdout.trim() === "") {
    // Seeded from the remote head under an explicit refspec. Anything that
    // reads a local branch here bases the whole epic on whatever happened to be
    // checked out, which is how an epic silently starts behind main.
    const fetchBaseArgs = ["fetch", "origin", `+refs/heads/${base_branch}:refs/remotes/origin/${base_branch}`] as const;
    const fetchedBase = await git.run(repository_path, fetchBaseArgs);
    if (fetchedBase.exit_code !== 0) {
      return err({ kind: "missing_base_branch", repository_key, repository_path, base_branch, detail: outcomeDetail(fetchedBase) });
    }
    const pushArgs = ["push", "origin", `origin/${base_branch}:${epicRef}`] as const;
    const pushed = await git.run(repository_path, pushArgs);
    if (pushed.exit_code !== 0) {
      // A concurrent seeder is benign: re-check before reporting, because the
      // branch it published is exactly the one this unit was going to create.
      const recheck = await git.run(repository_path, lsRemoteArgs);
      if (recheck.exit_code !== 0 || recheck.stdout.trim() === "") {
        return err({ kind: "epic_branch_unavailable", repository_key, repository_path, epic_branch, detail: outcomeDetail(pushed) });
      }
    }
  }

  const fetchEpicArgs = ["fetch", "origin", epic_branch] as const;
  const fetchedEpic = await git.run(repository_path, fetchEpicArgs);
  if (fetchedEpic.exit_code !== 0) return commandFailure(fetchEpicArgs, fetchedEpic);

  const revParseArgs = ["rev-parse", "--verify", `origin/${epic_branch}^{commit}`] as const;
  const head = await git.run(repository_path, revParseArgs);
  if (head.exit_code !== 0 || head.stdout.trim() === "") return commandFailure(revParseArgs, head);

  return ok({ repository_key, repository_path, base_branch, epic_branch, epic_head_sha: head.stdout.trim() });
};
