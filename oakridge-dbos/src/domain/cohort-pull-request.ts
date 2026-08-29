/**
 * Deciding whether a cohort's pull request really merged.
 *
 * A build unit's `build_result` is released through a handoff whose external
 * wait is `github_review`. Something outside the run has to say that wait is
 * over, and "something said so" is not good enough: the whole point of the wait
 * is that the cohort's work landed, so the evidence has to be checked against
 * what the build itself reported opening.
 *
 * The check is deliberately graded rather than all-or-nothing. Identity — the
 * pull request URL and the head branch — comes from the cohort's own
 * `pr_summary` artifact and is always available, so it is always checked; those
 * two are what stop a merge of some other branch being accepted here. The forge
 * binding and the expected base branch come from an Epic profile, which not
 * every run has. v1 refused outright without one. Refusing means a run launched
 * without an Epic can never finish, so an absent expectation is skipped and
 * recorded as skipped instead.
 */
import type { ForgeRepositoryIdentity } from "./epic";
import type { ArtifactId, JsonValue, StageInstanceId, UnitId, WorkflowRunId } from "./primitives";
import {
  parseGithubPullRequestIdentity, pullRequestMismatch, pullRequestUrlsMatch, repositoriesMatch,
  type PullRequestMismatch, type PullRequestObservation,
} from "./pull-request";

/** The run-owned facts required to reconcile one cohort's external handoff. */
export interface RunOwnedCohortHandoff {
  readonly run_id: WorkflowRunId;
  readonly stage_instance_id: StageInstanceId;
  readonly unit_id: UnitId;
  readonly repository_key: string;
  readonly handoff_artifact_id: ArtifactId;
  readonly handoff_body: JsonValue;
  readonly summary_body: JsonValue;
}

/** What the run expects this cohort's pull request to be. */
export interface ExpectedCohortPullRequest {
  readonly run_id: WorkflowRunId;
  readonly stage_instance_id: StageInstanceId;
  readonly unit_id: UnitId;
  readonly repository_key: string;
  /** Where the build reported opening the pull request. */
  readonly url: string;
  /** The branch the build reported pushing. */
  readonly head_branch: string;
  /** The branch a cohort PR must target, when the run declares one. */
  readonly base_branch: string | null;
  /** The forge repository the run is bound to, when it is bound to one. */
  readonly forge_repository: ForgeRepositoryIdentity | null;
}

export interface CohortPullRequestReconciliation {
  readonly run_id: WorkflowRunId;
  readonly stage_instance_id: StageInstanceId;
  readonly unit_id: UnitId;
  readonly repository_key: string;
  readonly observation: PullRequestObservation;
  readonly mismatch: PullRequestMismatch | null;
  readonly completed_at: string | null;
  readonly updated_at: string;
}

/**
 * What the run should do with an observation.
 *
 * `merged` is the only outcome that completes the external wait. `waiting` is a
 * pull request that is genuinely still open — not an error, just not yet.
 */
export type CohortPullRequestOutcome =
  | { readonly kind: "merged" }
  | { readonly kind: "waiting" }
  | { readonly kind: "already_completed" }
  | { readonly kind: "mismatch"; readonly mismatch: PullRequestMismatch }
  | { readonly kind: "ignored_stale"; readonly mismatch: PullRequestMismatch };

export interface ReconcileCohortPullRequestInput {
  readonly expected: ExpectedCohortPullRequest;
  readonly observation: PullRequestObservation;
  readonly previous: CohortPullRequestReconciliation | null;
  readonly reconciled_at: string;
}

export interface ReconciledCohortPullRequest {
  readonly outcome: CohortPullRequestOutcome;
  readonly reconciliation: CohortPullRequestReconciliation;
}

/** The first expectation the observation fails, or null if it meets them all. */
const findMismatch = (expected: ExpectedCohortPullRequest, observation: PullRequestObservation): PullRequestMismatch | null => {
  const identity = parseGithubPullRequestIdentity(expected.url);
  if (!identity) {
    return pullRequestMismatch("pull_request_mismatch", "the cohort's pr_summary URL is not a canonical GitHub pull request URL");
  }
  if (!pullRequestUrlsMatch(expected.url, observation.url)) {
    return pullRequestMismatch("pull_request_mismatch", "observed pull request is not the one the build reported opening");
  }
  // The observation names its repository twice — in its URL and in its own
  // fields. They have to agree, or a caller could point a merged PR's URL at
  // one repository while reporting the state of another.
  if (!repositoriesMatch(observation.owner, observation.name, identity.owner, identity.name)) {
    return pullRequestMismatch("repository_mismatch", "observed pull request belongs to another repository than its own URL");
  }
  if (expected.forge_repository && !repositoriesMatch(observation.owner, observation.name, expected.forge_repository.owner, expected.forge_repository.name)) {
    return pullRequestMismatch("repository_mismatch", "observed pull request does not belong to the repository this run is bound to");
  }
  if (observation.head_branch !== expected.head_branch) {
    return pullRequestMismatch("head_branch_mismatch", `observed head branch '${observation.head_branch}' is not the cohort branch '${expected.head_branch}'`);
  }
  if (expected.base_branch !== null && observation.base_branch !== expected.base_branch) {
    return pullRequestMismatch("base_branch_mismatch", `observed base branch '${observation.base_branch}' is not the branch the cohort targets, '${expected.base_branch}'`);
  }
  if (observation.state === "closed_unmerged") {
    return pullRequestMismatch("closed_without_merge", "pull request was closed without merging");
  }
  if (observation.state === "merged" && observation.merged_at === null) {
    return pullRequestMismatch("pull_request_mismatch", "merged observation carries no merged_at evidence");
  }
  return null;
};

/**
 * `completed_at` is deliberately not set here even for a merge. It means "this
 * is the observation that closed the wait", and only the caller holding the
 * handoff knows whether the wait was open to be closed — a pull request can be
 * merged before the assessor has approved it, and recording that as completion
 * would leave a wait that later opens and never closes.
 */
export const reconcileCohortPullRequest = (input: ReconcileCohortPullRequestInput): ReconciledCohortPullRequest => {
  const record = (mismatch: PullRequestMismatch | null): CohortPullRequestReconciliation => ({
    run_id: input.expected.run_id, stage_instance_id: input.expected.stage_instance_id, unit_id: input.expected.unit_id,
    repository_key: input.expected.repository_key, observation: input.observation, mismatch,
    completed_at: input.previous?.completed_at ?? null, updated_at: input.reconciled_at,
  });

  if (input.previous?.completed_at) return { outcome: { kind: "already_completed" }, reconciliation: input.previous };
  // An observation older than the one already recorded says nothing new, and
  // acting on it would let a stale "open" undo a merge already reconciled.
  if (input.previous && Date.parse(input.previous.observation.observed_at) > Date.parse(input.observation.observed_at)) {
    return {
      outcome: { kind: "ignored_stale", mismatch: pullRequestMismatch("stale_observation", "observation is older than the reconciliation already recorded") },
      reconciliation: input.previous,
    };
  }

  const mismatch = findMismatch(input.expected, input.observation);
  if (mismatch) return { outcome: { kind: "mismatch", mismatch }, reconciliation: record(mismatch) };
  if (input.observation.state === "open") return { outcome: { kind: "waiting" }, reconciliation: record(null) };
  return { outcome: { kind: "merged" }, reconciliation: record(null) };
};

/** Stamps a reconciliation as the one that closed the cohort's external wait. */
export const withCompletion = (reconciliation: CohortPullRequestReconciliation, completed_at: string): CohortPullRequestReconciliation =>
  ({ ...reconciliation, completed_at: reconciliation.completed_at ?? completed_at, updated_at: completed_at });

/**
 * The evidence an operator supplies when they confirm a merge themselves.
 *
 * The poller is the normal path; this is the fallback for when it cannot see
 * the repository — no token, a forge the reader does not speak, a merge done
 * somewhere the API does not reflect. It asserts nothing the operator did not:
 * the identity is copied from what the build reported, so the same expectations
 * are checked against it as against a polled observation, and the record says
 * plainly that a human is the source.
 */
export const operatorMergedObservation = (expected: ExpectedCohortPullRequest, confirmedAt: string): PullRequestObservation | null => {
  const identity = parseGithubPullRequestIdentity(expected.url);
  if (!identity) return null;
  return {
    provider: "github", owner: identity.owner, name: identity.name, number: identity.number, url: expected.url,
    head_branch: expected.head_branch, base_branch: expected.base_branch ?? "", head_sha: null,
    state: "merged", source: "manual_recheck", observed_at: confirmedAt, merged_at: confirmedAt,
  };
};
