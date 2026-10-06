import type { GitCommandRunner } from "../../domain/repository-provisioning";
import { githubIdentityFromRemote } from "../../runtime/project-identity";
import type { ProviderResult, ProviderCallOptions } from "../provider";

export interface RepositoryPreparationInput { readonly repository_path: string; readonly expected_head: string | null }
export interface RepositoryPreparationResult { readonly repository_path: string; readonly head: string; readonly push_remote_owner: string }

/** A selected leaf operation. Its result is a durable input fact for a later action. */
export class RepositoryPreparationOperation {
  constructor(private readonly git: GitCommandRunner) {}

  async execute(input: RepositoryPreparationInput, options: ProviderCallOptions = {}): Promise<ProviderResult<RepositoryPreparationResult>> {
    const root = await this.git.run(input.repository_path, ["rev-parse", "--show-toplevel"], options);
    if (options.signal?.aborted) return { kind: "transiently_unavailable", detail: "repository preparation aborted" };
    if (root.exit_code !== 0) return { kind: "permanently_rejected", code: "worktree_unrecoverable",
      detail: `repository at ${input.repository_path} cannot be inspected: ${root.stderr}` };
    const head = await this.git.run(input.repository_path, ["rev-parse", "HEAD"], options);
    if (head.exit_code !== 0) return { kind: "transiently_unavailable", detail: `repository head unavailable: ${head.stderr}` };
    const sha = head.stdout.trim();
    if (input.expected_head !== null && sha !== input.expected_head) return { kind: "permanently_rejected", code: "head_changed",
      detail: `selected ${input.expected_head}, found ${sha}` };
    const remote = await this.git.run(input.repository_path, ["remote", "get-url", "--push", "origin"], options);
    if (options.signal?.aborted) return { kind: "transiently_unavailable", detail: "repository preparation aborted" };
    if (remote.exit_code !== 0) return { kind: "permanently_rejected", code: "worktree_unrecoverable", detail: `push remote unavailable: ${remote.stderr}` };
    const identity = githubIdentityFromRemote(remote.stdout);
    if (!identity) return { kind: "permanently_rejected", code: "worktree_unrecoverable", detail: "push remote is not a GitHub repository" };
    return { kind: "acknowledged", value: { repository_path: root.stdout.trim(), head: sha, push_remote_owner: identity.owner } };
  }
}
