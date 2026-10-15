import type { GitCommandRunner } from "../domain/repository-provisioning";
import { PROVIDER_ERROR_CODES } from "../effects/provider-catalog";
import { githubIdentityFromRemote } from "../runtime/project-identity";
import { isFields, isNonEmptyString, type OperationCallOptions, type OperationOutcome } from "./outcome";

/**
 * `repository.prepare` input, as OPERATION_REGISTRY declares it. `base_branch`
 * is the branch the run's work stacks on; `expected_head`, when given, pins the
 * commit that branch must be at on origin.
 */
export interface RepositoryPrepareInput { readonly repository_path: string; readonly base_branch: string; readonly expected_head: string | null }
/**
 * `repository_path` echoes the input path verbatim: a workflow joins the
 * prepared workspace back to its repository by that value, so it must not be
 * the canonical toplevel git reports (which differs for a trailing slash,
 * subdirectory or symlink). `head` is the base branch's tip on origin, never
 * the checkout's `HEAD`.
 */
export interface RepositoryPrepareOutput { readonly repository_path: string; readonly push_remote_owner: string; readonly head: string }

export function decodeRepositoryPrepareInput(value: unknown): RepositoryPrepareInput | null {
  if (!isFields(value) || !isNonEmptyString(value.repository_path) || !isNonEmptyString(value.base_branch)) return null;
  const expected_head = value.expected_head ?? null;
  if (expected_head !== null && !isNonEmptyString(expected_head)) return null;
  return { repository_path: value.repository_path, base_branch: value.base_branch, expected_head };
}

/** `git ls-remote --exit-code` exits 2 when the remote answered and has no matching ref. */
const LS_REMOTE_NO_MATCH = 2;

/**
 * Resolves the base branch's tip on origin, and the push identity.
 *
 * The head is read from origin rather than from the checkout: the repository
 * path is the operator's own clone, checked out on whatever they last worked
 * on, and every session that reads or branches from `head` would otherwise
 * start from that branch instead of the one the run builds on. The fetch uses
 * an explicit refspec so `origin/<base>` resolves even in a clone whose fetch
 * refspec does not cover it.
 *
 * It writes only the base branch's remote-tracking ref, so a re-run for the same
 * action is the same call, though it may observe a newer tip.
 */
export async function prepareRepository(git: GitCommandRunner, input: RepositoryPrepareInput, options: OperationCallOptions = {}): Promise<OperationOutcome> {
  const aborted = (): OperationOutcome => ({ kind: "unavailable", detail: "repository preparation aborted" });
  const { repository_path, base_branch } = input;
  const root = await git.run(repository_path, ["rev-parse", "--show-toplevel"], options);
  if (options.signal?.aborted) return aborted();
  if (root.exit_code !== 0) return { kind: "failed", code: PROVIDER_ERROR_CODES.worktree_unrecoverable,
    detail: `repository at ${repository_path} cannot be inspected: ${root.stderr.trim()}` };
  const branch_name = await git.run(repository_path, ["check-ref-format", "--branch", base_branch], options);
  if (options.signal?.aborted) return aborted();
  if (branch_name.exit_code !== 0) return { kind: "failed", code: PROVIDER_ERROR_CODES.base_branch_missing,
    detail: `base branch ${JSON.stringify(base_branch)} is not a valid branch name` };
  const remote = await git.run(repository_path, ["remote", "get-url", "--push", "origin"], options);
  if (options.signal?.aborted) return aborted();
  if (remote.exit_code !== 0) return { kind: "failed", code: PROVIDER_ERROR_CODES.worktree_unrecoverable,
    detail: `push remote unavailable: ${remote.stderr.trim()}` };
  const identity = githubIdentityFromRemote(remote.stdout);
  if (!identity) return { kind: "failed", code: PROVIDER_ERROR_CODES.worktree_unrecoverable, detail: "push remote is not a GitHub repository" };

  const base_ref = `refs/heads/${base_branch}`;
  const published = await git.run(repository_path, ["ls-remote", "--exit-code", "origin", base_ref], options);
  if (options.signal?.aborted) return aborted();
  if (published.exit_code === LS_REMOTE_NO_MATCH) return { kind: "failed", code: PROVIDER_ERROR_CODES.base_branch_missing,
    detail: `origin has no branch ${base_branch}` };
  if (published.exit_code !== 0) return { kind: "unavailable", detail: `origin unreachable: ${published.stderr.trim()}` };
  const fetched = await git.run(repository_path, ["fetch", "--no-tags", "origin", `+${base_ref}:refs/remotes/origin/${base_branch}`], options);
  if (options.signal?.aborted) return aborted();
  if (fetched.exit_code !== 0) return { kind: "unavailable", detail: `base branch fetch failed: ${fetched.stderr.trim()}` };
  const head = await git.run(repository_path, ["rev-parse", "--verify", `refs/remotes/origin/${base_branch}^{commit}`], options);
  if (options.signal?.aborted) return aborted();
  if (head.exit_code !== 0) return { kind: "unavailable", detail: `base branch head unavailable: ${head.stderr.trim()}` };
  const sha = head.stdout.trim();
  if (input.expected_head !== null && sha !== input.expected_head) return { kind: "failed", code: PROVIDER_ERROR_CODES.head_changed,
    detail: `expected ${base_branch} at ${input.expected_head}, found ${sha}` };
  const body: RepositoryPrepareOutput = { repository_path, push_remote_owner: identity.owner, head: sha };
  return { kind: "succeeded", body };
}
