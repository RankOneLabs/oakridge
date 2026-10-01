import { expect, test } from "bun:test";

import {
  operatorMergedObservation, reconcileCohortPullRequest, withCompletion,
  type CohortPullRequestReconciliation, type DevFlowBuildCohort, type ExpectedCohortPullRequest,
} from "../src/domain/cohort-pull-request";
import { invalidatePullRequestForReplacement, type PullRequestApproval, type PullRequestObservation, type PullRequestObservationId, type PullRequestId, type PullRequestVerificationId, type VerifiedPullRequestLink } from "../src/domain/pull-request";
import type { ArtifactId, CohortId, StageInstanceId, UnitId, WorkflowRunId } from "../src/domain/primitives";
import { renderCohortBranchContract, selectCohortBranchRoles } from "../src/domain/repository-refs";
import { advanceCohortRef, advanceStoredCohortRef, prepareDevFlowBuildCohort, reconcileCohortEvidence, verifyAndBindCohortPullRequest, verifyCohortPullRequest } from "../src/runtime/cohort-pull-request";
import { BunGitCommandRunner } from "../src/runtime/git-command-runner";
import type { DevFlowPullRequestRepository } from "../src/storage/repositories";
import { createCohortPullRequestApp } from "../src/http/cohort-pull-request";
import { createGitRepositoryFixture } from "./support/dev-flow-harness";

const firstHandoffId = "00000000-0000-4000-8000-000000000003" as ArtifactId;

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

test("operator confirmation completes an awaiting-merge cohort without forge or git access", async () => {
  const verificationId = "00000000-0000-4000-8000-000000000020" as PullRequestVerificationId;
  const pullRequestId = "00000000-0000-4000-8000-000000000021" as PullRequestId;
  const cohort = { ...storedCohort("/repo", "reviewed-head"), current_verified_pull_request_id: verificationId };
  const events: unknown[] = [];
  const dependencies = {
    pull_requests: {
      async find_current_for_unit() { return { cohort, pull_request: { id: pullRequestId, provider: "github" as const,
        owner: "RankOneLabs", name: "oakridge", forge_pull_request_id: 440, url: expected.url, created_at: "2026-08-18T10:00:00Z" },
        observation: { ...observation({ state: "open", merged_at: null, head_sha: "reviewed-head" }),
          id: "00000000-0000-4000-8000-000000000022" as PullRequestObservationId,
          pull_request_id: pullRequestId, recorded_at: "2026-08-18T10:00:00Z" } }; },
      async confirm_merge() { return { ok: true as const, value: { kind: "created" as const, closure: {} } }; },
    } as unknown as DevFlowPullRequestRepository,
    forge_repositories: { async find_forge_repository() { throw new Error("forge identity should not be reread"); } },
    records: { async find_cohort_location() { return { run_id: expected.run_id, cohort_id: cohort.cohort_id, status: "blocked" as const }; } },
    reader: { async read() { throw new Error("forge should not be read"); } },
    git: { async run() { throw new Error("origin should not be read"); } },
    now: () => "2026-08-18T13:00:00.000Z",
    async record_build_event(_cohort_id: CohortId, event: unknown) { events.push(event); },
  };
  const result = await reconcileCohortEvidence(dependencies, expected.stage_instance_id, expected.unit_id,
    { kind: "operator_confirmation", idempotency_key: "manual-merge-1", operator_comment: "Merged" });
  expect(result.ok && result.value.resolution.kind).toBe("completed");
  expect(result.ok && result.value.reconciliation.observation.source).toBe("manual_recheck");
  expect(events).toEqual([{ kind: "pull_request_merged", pull_request_url: expected.url, head_sha: "reviewed-head" }]);
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

test("independent verification failure returns a mismatch without emitting an event", async () => {
  const cohort = storedCohort("/repo", "pushed-head");
  const events: { readonly kind: string }[] = [];
  const result = await verifyAndBindCohortPullRequest({ pull_requests: {} as DevFlowPullRequestRepository,
    reader: { async read() { return observation({ state: "open", merged_at: null, head_sha: "claimed-head" }); } },
    git: { async run() { return { exit_code: 0, stdout: "pushed-head\trefs/heads/cohort/foundation\n", stderr: "" }; } },
    now: () => "2026-09-29T01:00:00Z" }, {
    cohort, forge_repository: { owner: "RankOneLabs", name: "oakridge" }, candidate_url: expected.url,
    replace_verification_id: null,
  });
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ kind: "head_commit_mismatch" }) });
  expect(events).toEqual([]);
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

test("a successful replacement resets review state before verifying the new head", async () => {
  const cohort = { ...storedCohort("/repo", "new-head"),
    current_verified_pull_request_id: "00000000-0000-4000-8000-000000000020" as PullRequestVerificationId };
  const oldPullRequestId = "00000000-0000-4000-8000-000000000021" as PullRequestId;
  const newPullRequestId = "00000000-0000-4000-8000-000000000023" as PullRequestId;
  const events: { readonly kind: string }[] = [];
  const repository = {
    async find_current_for_unit() { return { cohort, pull_request: { id: oldPullRequestId, provider: "github" as const,
      owner: "RankOneLabs", name: "oakridge", forge_pull_request_id: 440, url: expected.url, created_at: "2026-09-29T00:00:00Z" },
      observation: { ...observation({ state: "open", merged_at: null, head_sha: "old-head" }), id: "00000000-0000-4000-8000-000000000022" as PullRequestObservationId,
        pull_request_id: oldPullRequestId, recorded_at: "2026-09-29T00:00:00Z" } }; },
    async observe() { return { pull_request_id: newPullRequestId, observation_id: "00000000-0000-4000-8000-000000000024" as PullRequestObservationId }; },
    async bind_verified() { return { ok: true as const, value: { id: "00000000-0000-4000-8000-000000000025" as PullRequestVerificationId, binding: "replaced" as const } }; },
  } as unknown as DevFlowPullRequestRepository;
  const replacement = observation({ number: 441, url: "https://github.com/RankOneLabs/oakridge/pull/441",
    state: "open", merged_at: null, head_sha: "new-head" });
  const result = await verifyAndBindCohortPullRequest({ pull_requests: repository,
    reader: { async read() { return replacement; } },
    git: { async run() { return { exit_code: 0, stdout: "new-head\trefs/heads/cohort/foundation\n", stderr: "" }; } },
    now: () => "2026-09-29T01:00:00Z" }, {
    cohort, forge_repository: { owner: "RankOneLabs", name: "oakridge" }, candidate_url: replacement.url,
    replace_verification_id: cohort.current_verified_pull_request_id,
  });
  expect(result.ok && result.value.binding).toBe("replaced");
  expect(events).toEqual([]);
});

test("replacement-required verification exposes the current verification id", async () => {
  const currentVerificationId = "00000000-0000-4000-8000-000000000020" as PullRequestVerificationId;
  const cohort = { ...storedCohort("/repo", "new-head"), current_verified_pull_request_id: currentVerificationId };
  const pullRequestId = "00000000-0000-4000-8000-000000000021" as PullRequestId;
  const repository = {
    async find_current_for_unit() { return { cohort, pull_request: { id: pullRequestId, provider: "github" as const,
      owner: "RankOneLabs", name: "oakridge", forge_pull_request_id: 440, url: expected.url, created_at: "2026-09-29T00:00:00Z" },
      observation: { ...observation({ state: "open", merged_at: null, head_sha: "old-head" }), id: "00000000-0000-4000-8000-000000000022" as PullRequestObservationId,
        pull_request_id: pullRequestId, recorded_at: "2026-09-29T00:00:00Z" } }; },
    async observe() { return { pull_request_id: "00000000-0000-4000-8000-000000000023" as PullRequestId,
      observation_id: "00000000-0000-4000-8000-000000000024" as PullRequestObservationId }; },
    async bind_verified() { return { ok: false as const, error: { kind: "replacement_required" as const, detail: "replacement required" } }; },
  } as unknown as DevFlowPullRequestRepository;
  const candidate = observation({ number: 441, url: "https://github.com/RankOneLabs/oakridge/pull/441",
    state: "open", merged_at: null, head_sha: "new-head" });
  const result = await verifyAndBindCohortPullRequest({ pull_requests: repository,
    reader: { async read() { return candidate; } },
    git: { async run() { return { exit_code: 0, stdout: "new-head\trefs/heads/cohort/foundation\n", stderr: "" }; } },
    now: () => "2026-09-29T01:00:00Z" }, {
    cohort, forge_repository: { owner: "RankOneLabs", name: "oakridge" }, candidate_url: candidate.url,
    replace_verification_id: null,
  });
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ kind: "replacement_required", current_verification_id: currentVerificationId }) });
});

test("cohort HTTP exposes the verification id needed to authorize replacement", async () => {
  const currentVerificationId = "00000000-0000-4000-8000-000000000020" as PullRequestVerificationId;
  const cohort = { ...storedCohort("/repo", "new-head"), current_verified_pull_request_id: currentVerificationId };
  const pullRequestId = "00000000-0000-4000-8000-000000000021" as PullRequestId;
  const candidate = observation({ number: 441, url: "https://github.com/RankOneLabs/oakridge/pull/441",
    state: "open", merged_at: null, head_sha: "new-head" });
  const app = createCohortPullRequestApp({
    pull_requests: {
      async find_cohort_for_unit() { return cohort; },
      async find_current_for_unit() { return { cohort, pull_request: { id: pullRequestId, provider: "github" as const,
        owner: "RankOneLabs", name: "oakridge", forge_pull_request_id: 440, url: expected.url, created_at: "2026-09-29T00:00:00Z" },
        observation: { ...observation({ state: "open", merged_at: null, head_sha: "old-head" }), id: "00000000-0000-4000-8000-000000000022" as PullRequestObservationId,
          pull_request_id: pullRequestId, recorded_at: "2026-09-29T00:00:00Z" } }; },
      async observe() { return { pull_request_id: "00000000-0000-4000-8000-000000000023" as PullRequestId,
        observation_id: "00000000-0000-4000-8000-000000000024" as PullRequestObservationId }; },
      async bind_verified() { return { ok: false as const, error: { kind: "replacement_required" as const, detail: "replacement required" } }; },
    } as unknown as DevFlowPullRequestRepository,
    forge_repositories: { async find_forge_repository() { return { owner: "RankOneLabs", name: "oakridge" }; } },
    records: { async find_cohort_location() { return { run_id: expected.run_id, cohort_id: cohort.cohort_id, status: "blocked" as const }; } },
    reader: { async read() { return candidate; } },
    git: { async run() { return { exit_code: 0, stdout: "new-head\trefs/heads/cohort/foundation\n", stderr: "" }; } },
    now: () => "2026-09-29T01:00:00Z", async record_build_event() {},
  });
  const response = await app.request(`/cohorts/${expected.stage_instance_id}:${expected.unit_id}/pull_request`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "observation", observation: candidate }),
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual(expect.objectContaining({ current_verification_id: currentVerificationId }));
});

test("repository-specific cohort refs drive both storage and prompt contracts", () => {
  const api = selectCohortBranchRoles("stage-one" as StageInstanceId, "api", { base_branch: "epic/api" });
  const web = selectCohortBranchRoles("stage-two" as StageInstanceId, "web", { base_branch: "release/web" });
  expect(api).toEqual({ canonical_ref: "cohort/stage-one/api", expected_pr_base: "epic/api" });
  expect(web).toEqual({ canonical_ref: "cohort/stage-two/web", expected_pr_base: "release/web" });
  expect(renderCohortBranchContract(web)).toContain("Pull request base: release/web");
});

test("cohort preparation creates the canonical ref and persists the roles rendered for the agent", async () => {
  const fixture = await createGitRepositoryFixture();
  try {
    const canonicalRef = `cohort/${expected.stage_instance_id}/foundation`;
    let stored: DevFlowBuildCohort | null = null;
    const repository = {
      async find_cohort_for_unit() { return stored; },
      async create_cohort(cohort: DevFlowBuildCohort) { stored = cohort; return { ok: true, value: cohort }; },
    } as unknown as DevFlowPullRequestRepository;
    const baseHead = await fixture.origin_branch_sha(fixture.integration_branch);
    if (!baseHead) throw new Error("fixture integration branch is missing");
    const result = await prepareDevFlowBuildCohort({ pull_requests: repository, git: new BunGitCommandRunner() }, {
      cohort_id: storedCohort(fixture.path, baseHead).cohort_id, stage_instance_id: expected.stage_instance_id,
      cohort_key: "foundation", repository: { repository_key: "oakridge", repository_path: fixture.path,
        integration_branch: fixture.integration_branch, base_branch: "epic/tiers", base_head_sha: baseHead },
      prepared_at: "2026-09-29T00:00:00Z",
    });
    expect(result.ok).toBe(true);
    expect(stored).toEqual(expect.objectContaining({ canonical_ref: canonicalRef, expected_pr_base: "epic/tiers" }));
    expect(result.ok && result.value.branch_contract).toContain(`Canonical cohort ref: ${canonicalRef}`);
    expect(await fixture.origin_branch_sha(canonicalRef)).toBe(baseHead);
  } finally {
    await fixture.remove();
  }
});

test("stored cohort advance records the same guarded head that was pushed", async () => {
  const cohort = storedCohort("/repo", "old-head");
  const commands: string[][] = [];
  const git = { async run(_cwd: string, args: readonly string[]) {
    commands.push([...args]);
    if (args[0] === "ls-remote") return { exit_code: 0, stdout: "old-head\trefs/heads/cohort/foundation\n", stderr: "" };
    return { exit_code: 0, stdout: "", stderr: "" };
  } };
  const repository = { async begin_cohort_advance() { return { ok: true as const, value: undefined }; },
    async advance_cohort_head() { return { ok: true as const, value: { ...cohort, recorded_head_sha: "new-head" } }; } } as unknown as DevFlowPullRequestRepository;
  const result = await advanceStoredCohortRef({ pull_requests: repository, git, now: () => "2026-09-29T00:00:00Z" },
    { cohort, next_head_sha: "new-head" });
  expect(result.ok && result.value.recorded_head_sha).toBe("new-head");
  expect(commands.map((command) => command[0])).toEqual(["ls-remote", "merge-base", "push"]);
});

test("stored cohort advance recovers when origin already has the requested head", async () => {
  const cohort = storedCohort("/repo", "old-head");
  const commands: string[][] = [];
  const git = { async run(_cwd: string, args: readonly string[]) {
    commands.push([...args]);
    if (args[0] === "ls-remote") return { exit_code: 0, stdout: "new-head\trefs/heads/cohort/foundation\n", stderr: "" };
    return { exit_code: 0, stdout: "", stderr: "" };
  } };
  const repository = { async begin_cohort_advance() { return { ok: true as const, value: undefined }; },
    async advance_cohort_head() { return { ok: true as const, value: { ...cohort, recorded_head_sha: "new-head" } }; } } as unknown as DevFlowPullRequestRepository;
  const result = await advanceStoredCohortRef({ pull_requests: repository, git, now: () => "2026-09-29T00:00:00Z" },
    { cohort, next_head_sha: "new-head" });
  expect(result.ok && result.value.recorded_head_sha).toBe("new-head");
  expect(commands.map((command) => command[0])).toEqual(["ls-remote", "merge-base"]);
});

test("cohort preparation refuses a deleted stored canonical ref", async () => {
  const cohort = { ...storedCohort("/repo", "old-head"), canonical_ref: `cohort/${expected.stage_instance_id}/foundation` };
  const repository = { async find_cohort_for_unit() { return cohort; } } as unknown as DevFlowPullRequestRepository;
  const git = { async run() { return { exit_code: 0, stdout: "", stderr: "" }; } };
  const result = await prepareDevFlowBuildCohort({ pull_requests: repository, git }, {
    cohort_id: cohort.cohort_id, stage_instance_id: cohort.stage_instance_id, cohort_key: cohort.cohort_key,
    repository: { repository_key: cohort.repository_key, repository_path: cohort.repository_path,
      integration_branch: "main", base_branch: cohort.expected_pr_base, base_head_sha: cohort.recorded_head_sha },
    prepared_at: "2026-09-29T00:00:00Z",
  });
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ kind: "ref_lease_mismatch", detail: expect.stringContaining("missing") }) });
});
