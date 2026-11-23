/** What the run observed about one pull request on a forge. */

export type ObservedPullRequestState = "open" | "merged" | "closed_unmerged";

/**
 * The `pull_request.inspect` output: the state of the pull request the watch's
 * query names. The repository and branches are the query's, so they are not
 * repeated here.
 */
export interface PullRequestInspection {
  readonly status: ObservedPullRequestState;
  readonly pr_sequence: number;
  readonly observed_link: string;
  readonly head_sha: string | null;
  readonly merged_at: string | null;
}
