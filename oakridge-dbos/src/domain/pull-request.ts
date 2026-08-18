/**
 * What the run knows about a pull request on a forge, and how it decides that
 * what it observed is the pull request it was waiting for.
 *
 * Two different waits reconcile against this vocabulary — a cohort's
 * `github_review` handoff and an epic's final integration merge — so the
 * observation, the mismatch taxonomy and the URL identity live here rather than
 * inside either one.
 */
export type PullRequestObservationSource = "poll" | "webhook" | "manual_recheck";
export type ObservedPullRequestState = "open" | "merged" | "closed_unmerged";

export interface PullRequestObservation {
  readonly provider: "github";
  readonly owner: string;
  readonly name: string;
  readonly number: number;
  readonly url: string;
  readonly head_branch: string;
  readonly base_branch: string;
  readonly head_sha: string | null;
  readonly state: ObservedPullRequestState;
  readonly source: PullRequestObservationSource;
  readonly observed_at: string;
  readonly merged_at: string | null;
}

export type PullRequestMismatchKind =
  | "missing_repository_identity"
  | "repository_mismatch"
  | "pull_request_mismatch"
  | "head_branch_mismatch"
  | "base_branch_mismatch"
  | "closed_without_merge"
  | "stale_observation";

export interface PullRequestMismatch {
  readonly kind: PullRequestMismatchKind;
  readonly detail: string;
}

export const pullRequestMismatch = (kind: PullRequestMismatchKind, detail: string): PullRequestMismatch => ({ kind, detail });

export interface PullRequestIdentity {
  readonly owner: string;
  readonly name: string;
  readonly number: number;
}

export const parseGithubPullRequestIdentity = (url: string): PullRequestIdentity | null => {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)\/?$/.exec(url);
  if (!match) return null;
  return { owner: match[1]!, name: match[2]!, number: Number(match[3]) };
};

/** Forge repository names are case-insensitive; the rest of a URL is not. */
export const repositoriesMatch = (leftOwner: string, leftName: string, rightOwner: string, rightName: string): boolean =>
  leftOwner.toLocaleLowerCase("en-US") === rightOwner.toLocaleLowerCase("en-US")
  && leftName.toLocaleLowerCase("en-US") === rightName.toLocaleLowerCase("en-US");

/** Whether two URLs name the same pull request, ignoring owner/name casing. */
export const pullRequestUrlsMatch = (left: string, right: string): boolean => {
  const leftIdentity = parseGithubPullRequestIdentity(left);
  const rightIdentity = parseGithubPullRequestIdentity(right);
  return leftIdentity !== null && rightIdentity !== null
    && leftIdentity.number === rightIdentity.number
    && repositoriesMatch(leftIdentity.owner, leftIdentity.name, rightIdentity.owner, rightIdentity.name);
};
