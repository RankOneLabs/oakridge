import { expect, test } from "bun:test";

import {
  operatorMergedObservation, reconcileCohortPullRequest, withCompletion,
  type CohortPullRequestReconciliation, type ExpectedCohortPullRequest,
} from "../src/domain/cohort-pull-request";
import type { PullRequestObservation } from "../src/domain/pull-request";
import type { StageInstanceId, UnitId, WorkflowRunId } from "../src/domain/primitives";

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
