import type { PullRequestObservation } from "../domain/pull-request";
import { PROVIDER_ERROR_CODES } from "../effects/provider-catalog";
import type { PullRequestBranchQuery, PullRequestReader } from "../runtime/github-pull-requests";
import { isFields, isNonEmptyString, type OperationCallOptions, type OperationOutcome } from "./outcome";

/** `pull_request.observe` input, as OPERATION_REGISTRY declares it. */
export interface PullRequestObserveInput { readonly query: PullRequestBranchQuery }
export interface PullRequestObserveOutput { readonly observations: readonly PullRequestObservation[] }

export function decodePullRequestObserveInput(value: unknown): PullRequestObserveInput | null {
  if (!isFields(value) || !isFields(value.query)) return null;
  const { owner, name, head_owner, head_branch, base_branch } = value.query;
  if (![owner, name, head_owner, head_branch, base_branch].every(isNonEmptyString)) return null;
  return { query: { owner: owner as string, name: name as string, head_owner: head_owner as string,
    head_branch: head_branch as string, base_branch: base_branch as string } };
}

/**
 * The pull requests from a head branch into a base branch, as the forge
 * reports them now. Read-only; a periodic worker publishes only a changed list.
 * Without a reader (no forge token) the operation fails rather than guessing.
 */
export async function observePullRequests(reader: PullRequestReader | null, input: PullRequestObserveInput,
  options: OperationCallOptions = {}): Promise<OperationOutcome> {
  if (!reader?.find_for_branches) return { kind: "failed", code: PROVIDER_ERROR_CODES.discovery_unsupported,
    detail: "no pull request reader with branch discovery is configured" };
  const result = await reader.find_for_branches(input.query, options);
  if (result.ok) {
    const body: PullRequestObserveOutput = { observations: result.value };
    return { kind: "succeeded", body };
  }
  switch (result.error.kind) {
    case "auth": return { kind: "failed", code: PROVIDER_ERROR_CODES.auth, detail: result.error.detail };
    case "rejected": return { kind: "failed", code: PROVIDER_ERROR_CODES.provider_rejected, detail: result.error.detail };
    case "unavailable": return { kind: "unavailable", detail: result.error.detail };
  }
}
