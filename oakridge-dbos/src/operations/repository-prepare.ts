import type { GitCommandRunner } from "../domain/repository-provisioning";
import { PROVIDER_ERROR_CODES } from "../effects/provider-catalog";
import { githubIdentityFromRemote } from "../runtime/project-identity";
import { isFields, isNonEmptyString, type OperationCallOptions, type OperationOutcome } from "./outcome";

/** `repository.prepare` input, as OPERATION_REGISTRY declares it. */
export interface RepositoryPrepareInput { readonly repository_path: string; readonly expected_head: string | null }
/**
 * `repository_path` echoes the input path verbatim: a workflow joins the
 * prepared workspace back to its repository by that value, so it must not be
 * the canonical toplevel git reports (which differs for a trailing slash,
 * subdirectory or symlink).
 */
export interface RepositoryPrepareOutput { readonly repository_path: string; readonly push_remote_owner: string; readonly head: string }

export function decodeRepositoryPrepareInput(value: unknown): RepositoryPrepareInput | null {
  if (!isFields(value) || !isNonEmptyString(value.repository_path)) return null;
  const expected_head = value.expected_head ?? null;
  if (expected_head !== null && !isNonEmptyString(expected_head)) return null;
  return { repository_path: value.repository_path, expected_head };
}

/** Reads the repository's head and push identity. Read-only, so a re-run for the same action is the same call. */
export async function prepareRepository(git: GitCommandRunner, input: RepositoryPrepareInput, options: OperationCallOptions = {}): Promise<OperationOutcome> {
  const aborted = (): OperationOutcome => ({ kind: "unavailable", detail: "repository preparation aborted" });
  const root = await git.run(input.repository_path, ["rev-parse", "--show-toplevel"], options);
  if (options.signal?.aborted) return aborted();
  if (root.exit_code !== 0) return { kind: "failed", code: PROVIDER_ERROR_CODES.worktree_unrecoverable,
    detail: `repository at ${input.repository_path} cannot be inspected: ${root.stderr.trim()}` };
  const head = await git.run(input.repository_path, ["rev-parse", "HEAD"], options);
  if (options.signal?.aborted) return aborted();
  if (head.exit_code !== 0) return { kind: "unavailable", detail: `repository head unavailable: ${head.stderr.trim()}` };
  const sha = head.stdout.trim();
  if (input.expected_head !== null && sha !== input.expected_head) return { kind: "failed", code: PROVIDER_ERROR_CODES.head_changed,
    detail: `expected ${input.expected_head}, found ${sha}` };
  const remote = await git.run(input.repository_path, ["remote", "get-url", "--push", "origin"], options);
  if (options.signal?.aborted) return aborted();
  if (remote.exit_code !== 0) return { kind: "failed", code: PROVIDER_ERROR_CODES.worktree_unrecoverable,
    detail: `push remote unavailable: ${remote.stderr.trim()}` };
  const identity = githubIdentityFromRemote(remote.stdout);
  if (!identity) return { kind: "failed", code: PROVIDER_ERROR_CODES.worktree_unrecoverable, detail: "push remote is not a GitHub repository" };
  const body: RepositoryPrepareOutput = { repository_path: input.repository_path, push_remote_owner: identity.owner, head: sha };
  return { kind: "succeeded", body };
}
