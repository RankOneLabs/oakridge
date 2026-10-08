/** What the run observed about a pull request on a forge. */

type PullRequestObservationSource = "poll" | "webhook" | "manual_recheck";
type ObservedPullRequestState = "open" | "merged" | "closed_unmerged";

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
