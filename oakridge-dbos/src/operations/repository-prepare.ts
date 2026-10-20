import type { GitCommandOutcome, GitCommandRunner } from "../domain/repository-provisioning";
import { PROVIDER_ERROR_CODES } from "../effects/provider-catalog";
import { githubIdentityFromRemote } from "../runtime/project-identity";
import { isFields, isNonEmptyString, type OperationCallOptions, type OperationOutcome } from "./outcome";

/**
 * `repository.prepare` input, as OPERATION_REGISTRY declares it.
 * `base_branch` is the branch the run builds on; when origin lacks it, it is
 * cut from `integration_branch`.
 */
export interface RepositoryPrepareInput {
  readonly repository_path: string;
  readonly expected_head: string | null;
  readonly base_branch: string;
  readonly integration_branch: string;
}
/**
 * `repository_path` echoes the input path verbatim: a workflow joins the
 * prepared workspace back to its repository by that value, so it must not be
 * the canonical toplevel git reports (which differs for a trailing slash,
 * subdirectory or symlink). `head` is the base branch's commit on origin,
 * which every session's worktree is cut from.
 */
export interface RepositoryPrepareOutput { readonly repository_path: string; readonly push_remote_owner: string; readonly head: string }

export function decodeRepositoryPrepareInput(value: unknown): RepositoryPrepareInput | null {
  if (!isFields(value) || !isNonEmptyString(value.repository_path)) return null;
  if (!isNonEmptyString(value.base_branch) || !isNonEmptyString(value.integration_branch)) return null;
  const expected_head = value.expected_head ?? null;
  if (expected_head !== null && !isNonEmptyString(expected_head)) return null;
  return { repository_path: value.repository_path, expected_head, base_branch: value.base_branch, integration_branch: value.integration_branch };
}

/** The command's stderr, or its stdout when it said nothing there, so a failure is never blank. */
const outcomeDetail = (outcome: GitCommandOutcome): string =>
  outcome.stderr.trim() || outcome.stdout.trim() || `exited with code ${outcome.exit_code}`;

/**
 * Reads the repository's head and push identity, and makes sure origin has
 * the base branch the run builds on. Ported from v1's `ensureEpicBranchExists`:
 *
 * - `ls-remote` first, so a base branch that already exists is never reseeded
 *   from the integration branch and silently rewound.
 * - Seed from `origin/<integration>` fetched under an explicit refspec, never
 *   from a local branch, so the run cannot start from a stale checkout.
 * - A failed push is re-checked rather than reported: a concurrent seeder is a
 *   benign race, and the branch it created is the one we wanted.
 *
 * So a re-run for the same action is the same call: the push happens at most
 * once, and every later call finds the branch.
 */
export async function prepareRepository(git: GitCommandRunner, input: RepositoryPrepareInput, options: OperationCallOptions = {}): Promise<OperationOutcome> {
  const aborted = (): OperationOutcome => ({ kind: "unavailable", detail: "repository preparation aborted" });
  const run = (args: readonly string[]) => git.run(input.repository_path, args, options);
  const root = await run(["rev-parse", "--show-toplevel"]);
  if (options.signal?.aborted) return aborted();
  if (root.exit_code !== 0) return { kind: "failed", code: PROVIDER_ERROR_CODES.worktree_unrecoverable,
    detail: `repository at ${input.repository_path} cannot be inspected: ${root.stderr.trim()}` };
  const head = await run(["rev-parse", "HEAD"]);
  if (options.signal?.aborted) return aborted();
  if (head.exit_code !== 0) return { kind: "unavailable", detail: `repository head unavailable: ${head.stderr.trim()}` };
  const sha = head.stdout.trim();
  if (input.expected_head !== null && sha !== input.expected_head) return { kind: "failed", code: PROVIDER_ERROR_CODES.head_changed,
    detail: `expected ${input.expected_head}, found ${sha}` };
  const remote = await run(["remote", "get-url", "--push", "origin"]);
  if (options.signal?.aborted) return aborted();
  if (remote.exit_code !== 0) return { kind: "failed", code: PROVIDER_ERROR_CODES.worktree_unrecoverable,
    detail: `push remote unavailable: ${remote.stderr.trim()}` };
  const identity = githubIdentityFromRemote(remote.stdout);
  if (!identity) return { kind: "failed", code: PROVIDER_ERROR_CODES.worktree_unrecoverable, detail: "push remote is not a GitHub repository" };

  const baseRef = `refs/heads/${input.base_branch}`;
  const listBase = ["ls-remote", "origin", baseRef];
  const published = await run(listBase);
  if (options.signal?.aborted) return aborted();
  if (published.exit_code !== 0) return { kind: "unavailable", detail: `origin unreachable: ${outcomeDetail(published)}` };
  if (published.stdout.trim() === "") {
    const integration = input.integration_branch;
    const fetched = await run(["fetch", "origin", `+refs/heads/${integration}:refs/remotes/origin/${integration}`]);
    if (options.signal?.aborted) return aborted();
    if (fetched.exit_code !== 0) return { kind: "failed", code: PROVIDER_ERROR_CODES.provider_rejected,
      detail: `origin has no integration branch ${integration} to cut ${input.base_branch} from: ${outcomeDetail(fetched)}` };
    const pushed = await run(["push", "origin", `refs/remotes/origin/${integration}:${baseRef}`]);
    if (options.signal?.aborted) return aborted();
    if (pushed.exit_code !== 0) {
      const recheck = await run(listBase);
      if (recheck.exit_code !== 0 || recheck.stdout.trim() === "") return { kind: "failed", code: PROVIDER_ERROR_CODES.provider_rejected,
        detail: `could not create ${input.base_branch} on origin: ${outcomeDetail(pushed)}` };
    }
  }

  // An explicit refspec, because `git fetch origin <branch>` updates only
  // FETCH_HEAD unless the remote has a matching fetch refspec, and the
  // rev-parse below reads `origin/<branch>`.
  const fetchedBase = await run(["fetch", "origin", `+${baseRef}:refs/remotes/origin/${input.base_branch}`]);
  if (options.signal?.aborted) return aborted();
  if (fetchedBase.exit_code !== 0) return { kind: "unavailable", detail: `could not fetch ${input.base_branch}: ${outcomeDetail(fetchedBase)}` };
  const base = await run(["rev-parse", "--verify", `refs/remotes/origin/${input.base_branch}^{commit}`]);
  if (options.signal?.aborted) return aborted();
  if (base.exit_code !== 0 || base.stdout.trim() === "") return { kind: "unavailable", detail: `${input.base_branch} does not resolve: ${outcomeDetail(base)}` };
  const body: RepositoryPrepareOutput = { repository_path: input.repository_path, push_remote_owner: identity.owner, head: base.stdout.trim() };
  return { kind: "succeeded", body };
}
