import type { CohortId } from "./primitives";
import type { MergeClosureResult, PullRequestObservation, PullRequestVerificationId } from "./pull-request";
import type { FinalMergePolicy } from "./epic";
import type { RepositoryRefs, RunContextRepository } from "./repository-refs";

export interface ConfirmFinalPullRequestRequest {
  readonly idempotency_key: string;
  readonly operator_comment?: string;
}

/** Facts the ordinary final-integration stage adapter consumes in c8 composition. */
export type FinalPullRequestEvent =
  | { readonly kind: "pull_request_verified"; readonly cohort_id: CohortId; readonly verification_id: PullRequestVerificationId;
      readonly revision: string; readonly pull_request_url: string; readonly state: PullRequestObservation["state"] }
  | { readonly kind: "pull_request_merge_confirmed"; readonly cohort_id: CohortId; readonly pull_request_url: string;
      readonly confirmation: MergeClosureResult["kind"]; readonly operator_comment: string | null };

export type FinalPullRequestObservationOutcome = "waiting" | "merged_evidence" | "closed_without_merge";

export interface FinalPullRequestStageConfig {
  readonly canonical_ref: string;
  readonly expected_pr_base: string;
  readonly merge_policy: FinalMergePolicy;
}

/**
 * The final-stage adapter is the sole reader of integration policy and branch
 * configuration. Both now arrive from the run context — the epic profile table
 * is gone — but the reading is still this adapter's alone.
 */
export const selectFinalPullRequestStageConfig = (
  profile: { readonly final_merge_policy: FinalMergePolicy },
  repository: Pick<RunContextRepository, "integration_branch">,
  refs: Pick<RepositoryRefs, "base_branch">,
): FinalPullRequestStageConfig => ({
  canonical_ref: refs.base_branch,
  expected_pr_base: repository.integration_branch,
  merge_policy: profile.final_merge_policy,
});

export const selectFinalPullRequestObservationOutcome = (
  observation: PullRequestObservation,
): FinalPullRequestObservationOutcome => observation.state === "open"
  ? "waiting"
  : observation.state === "merged" ? "merged_evidence" : "closed_without_merge";
