import type { PullRequestObservation } from "../domain/pull-request";
import { err, ok, type Result } from "../domain/primitives";
import { PROVIDER_ERROR_CODES } from "../effects/provider-catalog";
import type { ForgePullRequest, PullRequestReader, PullRequestRef } from "../runtime/github-pull-requests";
import { isFields, isNonEmptyString, type OperationCallOptions, type OperationOutcome } from "./outcome";

/**
 * The pull request a watch observes: its url, and the repository and branches
 * it must have been opened between. The url names the pull request; the rest
 * is what the forge must confirm about it.
 */
export interface PullRequestWatchQuery {
  readonly owner: string;
  readonly name: string;
  readonly head_owner: string;
  readonly head_branch: string;
  readonly base_branch: string;
  readonly pr_url: string;
}
/** `pull_request.observe` input, as OPERATION_REGISTRY declares it. */
export interface PullRequestObserveInput { readonly query: PullRequestWatchQuery }
export type PullRequestObserveOutput = PullRequestObservation;

export function decodePullRequestObserveInput(value: unknown): PullRequestObserveInput | null {
  if (!isFields(value) || !isFields(value.query)) return null;
  const { owner, name, head_owner, head_branch, base_branch, pr_url } = value.query;
  if (!isNonEmptyString(owner) || !isNonEmptyString(name) || !isNonEmptyString(head_owner) || !isNonEmptyString(head_branch)
    || !isNonEmptyString(base_branch) || !isNonEmptyString(pr_url)) return null;
  return { query: { owner, name, head_owner, head_branch, base_branch, pr_url } };
}

const isSameName = (left: string, right: string): boolean => left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US");

/**
 * The pull request a url names in the query's repository:
 * `https://github.com/{owner}/{name}/pull/{number}`, with an optional trailing
 * slash, query or fragment. The owner and name compare without case, as
 * GitHub's do. Err names why the url names no pull request of the repository.
 */
export function selectPullRequestRef(query: PullRequestWatchQuery): Result<PullRequestRef, string> {
  let url: URL;
  try { url = new URL(query.pr_url); }
  catch { return err(`pr_url ${query.pr_url} is not a url`); }
  if (url.protocol !== "https:" || url.hostname.toLocaleLowerCase("en-US") !== "github.com")
    return err(`pr_url ${query.pr_url} is not a GitHub pull request url`);
  const [owner, name, kind, number, ...rest] = url.pathname.split("/").filter((segment) => segment !== "");
  if (!owner || !name || kind !== "pull" || !number || !/^[1-9][0-9]*$/.test(number) || rest.length > 0)
    return err(`pr_url ${query.pr_url} is not a GitHub pull request url`);
  if (!isSameName(owner, query.owner) || !isSameName(name, query.name))
    return err(`pr_url ${query.pr_url} is in ${owner}/${name}, not ${query.owner}/${query.name}`);
  return ok({ owner: query.owner, name: query.name, number: Number(number) });
}

/** Null when the pull request runs from the query's head into its base; otherwise what differs. */
export function selectBranchMismatch(query: PullRequestWatchQuery, pull_request: ForgePullRequest): string | null {
  const head = `${pull_request.head_owner ?? "(deleted repository)"}:${pull_request.head_branch}`;
  if (pull_request.head_owner === null || !isSameName(pull_request.head_owner, query.head_owner) || pull_request.head_branch !== query.head_branch)
    return `pull request #${pull_request.number} has head ${head}, not ${query.head_owner}:${query.head_branch}`;
  if (pull_request.base_branch !== query.base_branch)
    return `pull request #${pull_request.number} has base ${pull_request.base_branch}, not ${query.base_branch}`;
  return null;
}

export const selectObservation = (pull_request: ForgePullRequest): PullRequestObservation => ({ state: pull_request.state,
  number: pull_request.number, url: pull_request.url, head_sha: pull_request.head_sha, merged_at: pull_request.merged_at });

const mismatch = (detail: string): OperationOutcome => ({ kind: "failed", code: PROVIDER_ERROR_CODES.pull_request_mismatch, detail });

/**
 * The state of the pull request the query's url names, as the forge reports
 * it now. Read-only; a periodic worker publishes only a changed observation.
 * A url that names no pull request of the repository, a pull request the
 * forge does not have, or one between other branches fails as
 * `pull_request_mismatch`: the watch fails where the operator sees it rather
 * than watching nothing. Without a reader (no forge token) the operation fails
 * rather than guessing.
 */
export async function observePullRequest(reader: PullRequestReader | null, input: PullRequestObserveInput,
  options: OperationCallOptions = {}): Promise<OperationOutcome> {
  if (!reader) return { kind: "failed", code: PROVIDER_ERROR_CODES.discovery_unsupported,
    detail: "no pull request reader is configured" };
  const ref = selectPullRequestRef(input.query);
  if (!ref.ok) return mismatch(ref.error);
  const result = await reader.get(ref.value, options);
  if (!result.ok) switch (result.error.kind) {
    case "auth": return { kind: "failed", code: PROVIDER_ERROR_CODES.auth, detail: result.error.detail };
    case "rejected": return { kind: "failed", code: PROVIDER_ERROR_CODES.provider_rejected, detail: result.error.detail };
    case "unavailable": return { kind: "unavailable", detail: result.error.detail };
  }
  const pull_request = result.value;
  if (!pull_request) return mismatch(`${ref.value.owner}/${ref.value.name} has no pull request #${ref.value.number}`);
  const branch_mismatch = selectBranchMismatch(input.query, pull_request);
  if (branch_mismatch) return mismatch(branch_mismatch);
  const body: PullRequestObserveOutput = selectObservation(pull_request);
  return { kind: "succeeded", body };
}
