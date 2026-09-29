import { expect, test } from "bun:test";

import {
  operatorMergedObservation, reconcileCohortPullRequest, reconciliationForHandoff, withCompletion,
  type CohortPullRequestReconciliation, type DevFlowBuildCohort, type ExpectedCohortPullRequest,
} from "../src/domain/cohort-pull-request";
import { invalidatePullRequestForReplacement, type PullRequestApproval, type PullRequestObservation, type PullRequestObservationId, type PullRequestId, type PullRequestVerificationId, type VerifiedPullRequestLink } from "../src/domain/pull-request";
import type { ArtifactId, CohortId, StageInstanceId, UnitId, WorkflowRunId } from "../src/domain/primitives";
import { renderCohortBranchContract, selectCohortBranchRoles } from "../src/domain/repository-refs";
import { advanceCohortRef, verifyCohortPullRequest } from "../src/runtime/cohort-pull-request";
import { BunGitCommandRunner } from "../src/runtime/git-command-runner";
import { createGitRepositoryFixture } from "./support/dev-flow-harness";

const firstHandoffId = "00000000-0000-4000-8000-000000000003" as ArtifactId;
const secondHandoffId = "00000000-0000-4000-8000-000000000004" as ArtifactId;

const expected: ExpectedCohortPullRequest = {
  run_id: "00000000-0000-4000-8000-000000000001" as WorkflowRunId,
  stage_instance_id: "00000000-0000-4000-8000-000000000002" as StageInstanceId,
  unit_id: "foundation" as UnitId,
  repository_key: "oakridge",
  url: "https://github.com/RankOneLabs/oakridge/pull/440",
  head_branch: "cohort/foundation",
  base_branch: "epic/tiers",
  forge_repository: { provider: "github", owner: "RankOneLabs", name: "oakridge" },
};

const observation = (overrides: Partial<PullRequestObservation> = {}): PullRequestObservation => ({
  provider: "github", owner: "RankOneLabs", name: "oakridge", number: 440,
  url: "https://github.com/RankOneLabs/oakridge/pull/440",
  head_branch: "cohort/foundation", base_branch: "epic/tiers", head_sha: "abc123",
  state: "merged", source: "poll", observed_at: "2026-08-18T12:00:00.000Z", merged_at: "2026-08-18T11:59:00.000Z",
  ...overrides,
});

const reconcile = (input: { observation?: PullRequestObservation; previous?: CohortPullRequestReconciliation | null; expected?: ExpectedCohortPullRequest } = {}) =>
  reconcileCohortPullRequest({
    expected: input.expected ?? expected,
    handoff_artifact_id: firstHandoffId,
    observation: input.observation ?? observation(),
    previous: input.previous ?? null,
    reconciled_at: "2026-08-18T12:00:01.000Z",
  });

test("a merged pull request matching what the build reported reconciles as merged", () => {
  const result = reconcile();
  expect(result.outcome).toEqual({ kind: "merged" });
  expect(result.reconciliation.mismatch).toBeNull();
});

/**
 * A pull request can merge before the assessor has approved it. Recording that
 * as completion would leave a wait that opens later and never closes, so only
 * the caller holding the handoff stamps completion.
 */
test("reconciling a merge does not by itself claim the wait was closed", () => {
  expect(reconcile().reconciliation.completed_at).toBeNull();
  expect(withCompletion(reconcile().reconciliation, "2026-08-18T12:00:02.000Z").completed_at).toBe("2026-08-18T12:00:02.000Z");
});

test("an open pull request is waiting rather than a failure", () => {
  const result = reconcile({ observation: observation({ state: "open", merged_at: null }) });
  expect(result.outcome).toEqual({ kind: "waiting" });
  expect(result.reconciliation.completed_at).toBeNull();
});

test("a merge of a different pull request is refused", () => {
  const result = reconcile({ observation: observation({ number: 441, url: "https://github.com/RankOneLabs/oakridge/pull/441" }) });
  expect(result.outcome.kind).toBe("mismatch");
  expect(result.reconciliation.mismatch?.kind).toBe("pull_request_mismatch");
});

/**
 * The observation names its repository twice. A caller that gets to supply both
 * could otherwise point the expected PR's URL at one repository while reporting
 * a merge that happened in another.
 */
test("an observation whose repository disagrees with its own URL is refused", () => {
  const result = reconcile({ observation: observation({ owner: "someone-else" }) });
  expect(result.outcome.kind).toBe("mismatch");
  expect(result.reconciliation.mismatch?.kind).toBe("repository_mismatch");
});

test("a merge of a different branch under the right pull request number is refused", () => {
  const result = reconcile({ observation: observation({ head_branch: "cohort/web" }) });
  expect(result.outcome.kind).toBe("mismatch");
  expect(result.reconciliation.mismatch?.kind).toBe("head_branch_mismatch");
});

test("a pull request that landed on the wrong base branch is refused", () => {
  const result = reconcile({ observation: observation({ base_branch: "main" }) });
  expect(result.outcome.kind).toBe("mismatch");
  expect(result.reconciliation.mismatch?.kind).toBe("base_branch_mismatch");
});

test("a pull request closed without merging is refused", () => {
  const result = reconcile({ observation: observation({ state: "closed_unmerged", merged_at: null }) });
  expect(result.outcome.kind).toBe("mismatch");
  expect(result.reconciliation.mismatch?.kind).toBe("closed_without_merge");
});

test("a merged claim carrying no merged_at evidence is refused", () => {
  const result = reconcile({ observation: observation({ merged_at: null }) });
  expect(result.outcome.kind).toBe("mismatch");
  expect(result.reconciliation.mismatch?.kind).toBe("pull_request_mismatch");
});

/**
 * A run launched without an Epic profile has no forge binding and no declared
 * epic branch. v1 refused those outright, which means such a run could never
 * finish; the identity checks that come from the build's own report still hold.
 */
test("expectations the run cannot supply are skipped, not failed", () => {
  const result = reconcile({ expected: { ...expected, base_branch: null, forge_repository: null } });
  expect(result.outcome).toEqual({ kind: "merged" });
});

test("identity is still enforced when the run has no forge binding", () => {
  const result = reconcile({
    expected: { ...expected, base_branch: null, forge_repository: null },
    observation: observation({ head_branch: "cohort/web" }),
  });
  expect(result.outcome.kind).toBe("mismatch");
});

/**
 * Without this an observation that raced an earlier one could walk a merged
 * cohort back to open.
 */
test("an observation older than the one on record is ignored", () => {
  const previous = reconcile().reconciliation;
  const result = reconcile({ previous, observation: observation({ state: "open", merged_at: null, observed_at: "2026-08-18T11:00:00.000Z" }) });
  expect(result.outcome.kind).toBe("ignored_stale");
  expect(result.reconciliation).toEqual(previous);
});

test("a cohort already reconciled as merged stays merged", () => {
  const previous = withCompletion(reconcile().reconciliation, "2026-08-18T12:00:02.000Z");
  const result = reconcile({ previous, observation: observation({ state: "open", merged_at: null, observed_at: "2026-08-19T00:00:00.000Z" }) });
  expect(result.outcome).toEqual({ kind: "already_completed" });
  expect(result.reconciliation).toEqual(previous);
});

test("a new open handoff can reconcile a merge after an earlier handoff completed", () => {
  const previous = withCompletion(reconcile().reconciliation, "2026-08-18T12:00:02.000Z");
  const current = reconciliationForHandoff(previous, secondHandoffId, "pending");
  const result = reconcileCohortPullRequest({ expected, handoff_artifact_id: secondHandoffId,
    previous: current, observation: observation({ observed_at: "2026-08-19T00:00:00.000Z" }), reconciled_at: "2026-08-19T00:00:00.000Z" });
  expect(result.outcome).toEqual({ kind: "merged" });
  expect(result.reconciliation.handoff_artifact_id).toBe(secondHandoffId);
  expect(result.reconciliation.completed_at).toBeNull();
  expect(withCompletion(result.reconciliation, "2026-08-19T00:00:01.000Z").completed_at).toBe("2026-08-19T00:00:01.000Z");
});

test("a released handoff keeps its completed reconciliation", () => {
  const previous = withCompletion(reconcile().reconciliation, "2026-08-18T12:00:02.000Z");
  expect(reconciliationForHandoff(previous, firstHandoffId, "released")).toEqual(previous);
});

test("an invalidated handoff does not reset an earlier completion", () => {
  const previous = withCompletion(reconcile().reconciliation, "2026-08-18T12:00:02.000Z");
  expect(reconciliationForHandoff(previous, secondHandoffId, "invalidated")).toEqual(previous);
});

/**
 * The operator's fallback asserts only what the operator asserted. It copies
 * the identity from the build's own report, so it passes exactly the checks a
 * polled observation passes and none that it would not.
 */
test("an operator confirmation reconciles as a manually sourced merge", () => {
  const manual = operatorMergedObservation(expected, "2026-08-18T13:00:00.000Z");
  expect(manual?.source).toBe("manual_recheck");
  const result = reconcile({ observation: manual! });
  expect(result.outcome).toEqual({ kind: "merged" });
});

test("an operator cannot confirm a cohort whose reported URL is not a pull request", () => {
  expect(operatorMergedObservation({ ...expected, url: "https://example.test/nope" }, "2026-08-18T13:00:00.000Z")).toBeNull();
});

const storedCohort = (repositoryPath: string, head: string): DevFlowBuildCohort => ({
  cohort_id: "00000000-0000-4000-8000-000000000010" as CohortId,
  stage_instance_id: expected.stage_instance_id,
  cohort_key: "foundation",
  repository_key: "oakridge",
  repository_path: repositoryPath,
  canonical_ref: "cohort/foundation",
  expected_pr_base: "epic/tiers",
  recorded_head_sha: head,
  current_verified_pull_request_id: null,
  created_at: "2026-08-18T10:00:00Z",
  updated_at: "2026-08-18T10:00:00Z",
});

test("verification refuses a forge head commit that is not the pushed head", async () => {
  const fixture = await createGitRepositoryFixture();
  try {
    const git = new BunGitCommandRunner();
    const seeded = await git.run(fixture.path, ["push", "origin", `${fixture.integration_branch}:refs/heads/cohort/foundation`]);
    expect(seeded.exit_code).toBe(0);
    const pushedHead = await fixture.origin_branch_sha("cohort/foundation");
    if (!pushedHead) throw new Error("fixture cohort branch was not pushed");
    const reader = { async read() { return observation({ state: "open", merged_at: null, head_sha: `${pushedHead}bad` }); } };
    const result = await verifyCohortPullRequest({ reader, git }, {
      cohort: storedCohort(fixture.path, pushedHead),
      forge_repository: { owner: "RankOneLabs", name: "oakridge" },
      candidate_url: expected.url,
    });
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ kind: "head_commit_mismatch" }) });
  } finally {
    await fixture.remove();
  }
});

test("a drifted origin refuses a builder retry before it can reset the cohort ref", async () => {
  const fixture = await createGitRepositoryFixture();
  try {
    const git = new BunGitCommandRunner();
    expect((await git.run(fixture.path, ["push", "origin", `${fixture.integration_branch}:refs/heads/cohort/foundation`])).exit_code).toBe(0);
    const recordedHead = await fixture.origin_branch_sha("cohort/foundation");
    if (!recordedHead) throw new Error("fixture cohort branch was not pushed");
    const driftedHead = await fixture.advance_origin_branch("cohort/foundation", "assessor drift");
    const result = await advanceCohortRef(git, { cohort: storedCohort(fixture.path, recordedHead), next_head_sha: driftedHead });
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ kind: "ref_lease_mismatch" }) });
    expect(await fixture.origin_branch_sha("cohort/foundation")).toBe(driftedHead);
  } finally {
    await fixture.remove();
  }
});

test("replacing a pull request invalidates approvals tied to its old head", () => {
  const verification: VerifiedPullRequestLink = {
    id: "00000000-0000-4000-8000-000000000020" as PullRequestVerificationId,
    cohort_id: "00000000-0000-4000-8000-000000000010" as CohortId,
    pull_request_id: "00000000-0000-4000-8000-000000000021" as PullRequestId,
    observation_id: "00000000-0000-4000-8000-000000000022" as PullRequestObservationId,
    verified_head_sha: "abc", verified_at: "2026-08-18T10:00:00Z", invalidated_at: null, invalidation_reason: null,
  };
  const approvals: PullRequestApproval[] = [{ cohort_id: verification.cohort_id, verification_id: verification.id,
    approval_kind: "assessment_review", approved_at: "2026-08-18T11:00:00Z", invalidated_at: null }];
  const replaced = invalidatePullRequestForReplacement(verification, approvals, "2026-08-18T12:00:00Z");
  expect(replaced.previous_verification.invalidation_reason).toBe("replaced");
  expect(replaced.approvals[0]?.invalidated_at).toBe("2026-08-18T12:00:00Z");
});

test("repository-specific cohort refs drive both storage and prompt contracts", () => {
  const api = selectCohortBranchRoles("api", { base_branch: "epic/api" });
  const web = selectCohortBranchRoles("web", { base_branch: "release/web" });
  expect(api).toEqual({ canonical_ref: "cohort/api", expected_pr_base: "epic/api" });
  expect(web).toEqual({ canonical_ref: "cohort/web", expected_pr_base: "release/web" });
  expect(renderCohortBranchContract(web)).toContain("Pull request base: release/web");
});
