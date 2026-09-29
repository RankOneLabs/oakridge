/**
 * What the run knows about a pull request on a forge, and how it decides that
 * what it observed is the pull request it was waiting for.
 *
 * Two different waits reconcile against this vocabulary — a cohort's
 * `github_review` handoff and an epic's final integration merge — so the
 * observation, the mismatch taxonomy and the URL identity live here rather than
 * inside either one.
 */
import type { Brand, CohortId } from "./primitives";
import { err, ok, type Result } from "./primitives";

export type PullRequestId = Brand<string, "PullRequestId">;
export type PullRequestObservationId = Brand<string, "PullRequestObservationId">;
export type PullRequestVerificationId = Brand<string, "PullRequestVerificationId">;
export type PullRequestMergeClosureId = Brand<string, "PullRequestMergeClosureId">;

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

/** Durable forge identity. Observations are append-only children of this row. */
export interface PullRequest {
  readonly id: PullRequestId;
  readonly repository_key: string;
  readonly provider: "github";
  readonly owner: string;
  readonly name: string;
  readonly forge_pull_request_id: number;
  readonly url: string;
  readonly created_at: string;
}

/** One immutable reading from the forge. A later poll inserts another row. */
export interface StoredPullRequestObservation extends PullRequestObservation {
  readonly id: PullRequestObservationId;
  readonly pull_request_id: PullRequestId;
  readonly recorded_at: string;
}

/** Evidence produced only after the forge observation and origin ref agree. */
export interface VerifiedPullRequestLink {
  readonly id: PullRequestVerificationId;
  readonly cohort_id: CohortId;
  readonly pull_request_id: PullRequestId;
  readonly observation_id: PullRequestObservationId;
  readonly verified_head_sha: string;
  readonly verified_at: string;
  readonly invalidated_at: string | null;
  readonly invalidation_reason: "replaced" | "head_changed" | null;
}

/** Exact-once closure of a cohort after the verified PR has merged. */
export interface PullRequestMergeClosure {
  readonly id: PullRequestMergeClosureId;
  readonly cohort_id: CohortId;
  readonly pull_request_id: PullRequestId;
  readonly idempotency_key: string;
  readonly merged_at: string;
  readonly confirmed_at: string;
}

export interface PullRequestApproval {
  readonly cohort_id: CohortId;
  readonly verification_id: PullRequestVerificationId;
  readonly approval_kind: "build_review" | "assessment_review";
  readonly approved_at: string;
  readonly invalidated_at: string | null;
}

export interface PullRequestReplacement {
  readonly previous_verification: VerifiedPullRequestLink;
  readonly approvals: readonly PullRequestApproval[];
}

/** Replacement is explicit and makes every approval of the old head unusable. */
export const invalidatePullRequestForReplacement = (
  current: VerifiedPullRequestLink,
  approvals: readonly PullRequestApproval[],
  invalidatedAt: string,
): PullRequestReplacement => ({
  previous_verification: { ...current, invalidated_at: invalidatedAt, invalidation_reason: "replaced" },
  approvals: approvals.map((approval) => approval.verification_id === current.id && approval.invalidated_at === null
    ? { ...approval, invalidated_at: invalidatedAt }
    : approval),
});

export type MergeClosureResult =
  | { readonly kind: "created"; readonly closure: PullRequestMergeClosure }
  | { readonly kind: "replayed"; readonly closure: PullRequestMergeClosure };

export interface MergeClosureError {
  readonly operation: "close_pull_request_merge";
  readonly kind: "invalid_idempotency_key" | "idempotency_conflict";
  readonly detail: string;
}

/** Pure form of the database's UNIQUE(cohort_id) exact-once rule. */
export const closePullRequestMerge = (
  existing: PullRequestMergeClosure | null,
  proposed: PullRequestMergeClosure,
): Result<MergeClosureResult, MergeClosureError> => {
  if (proposed.idempotency_key.trim() === "") {
    return err({ operation: "close_pull_request_merge", kind: "invalid_idempotency_key", detail: "idempotency key must not be empty" });
  }
  if (!existing) return ok({ kind: "created", closure: proposed });
  if (existing.idempotency_key === proposed.idempotency_key) return ok({ kind: "replayed", closure: existing });
  return err({ operation: "close_pull_request_merge", kind: "idempotency_conflict", detail: "cohort merge was already confirmed with a different idempotency key" });
};

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
