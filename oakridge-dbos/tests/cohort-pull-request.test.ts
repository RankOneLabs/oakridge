import { expect, test } from "bun:test";

import {
  operatorMergedObservation, reconcileCohortPullRequest, reconciliationForHandoff, withCompletion,
  type CohortPullRequestReconciliation, type DevFlowBuildCohort, type ExpectedCohortPullRequest,
} from "../src/domain/cohort-pull-request";
import { invalidatePullRequestForReplacement, type PullRequestApproval, type PullRequestObservation, type PullRequestObservationId, type PullRequestId, type PullRequestVerificationId, type VerifiedPullRequestLink } from "../src/domain/pull-request";
import type { ArtifactId, CohortId, StageInstanceId, UnitId, WorkflowRunId } from "../src/domain/primitives";
import { renderCohortBranchContract, selectCohortBranchRoles } from "../src/domain/repository-refs";
import { advanceCohortRef, advanceStoredCohortRef, prepareDevFlowBuildCohort, reconcileCohortEvidence, verifyAndBindCohortPullRequest, verifyCohortPullRequest, verifyReportedCohortPullRequest } from "../src/runtime/cohort-pull-request";
import type { ReportedBuildCohortEvent } from "../src/adapters/dev-flow-build";
import { BunGitCommandRunner } from "../src/runtime/git-command-runner";
import type { DevFlowPullRequestRepository } from "../src/storage/repositories";
import { createCohortPullRequestApp } from "../src/http/cohort-pull-request";
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

test("independent verification failure emits the corrective build event", async () => {
  const cohort = storedCohort("/repo", "pushed-head");
  const events: { readonly kind: string }[] = [];
  const result = await verifyAndBindCohortPullRequest({ pull_requests: {} as DevFlowPullRequestRepository,
    reader: { async read() { return observation({ state: "open", merged_at: null, head_sha: "claimed-head" }); } },
    git: { async run() { return { exit_code: 0, stdout: "pushed-head\trefs/heads/cohort/foundation\n", stderr: "" }; } },
    now: () => "2026-09-29T01:00:00Z", async record_build_event(_id, event) { events.push(event); } }, {
    cohort, forge_repository: { owner: "RankOneLabs", name: "oakridge" }, candidate_url: expected.url,
    replace_verification_id: null,
  });
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ kind: "head_commit_mismatch" }) });
  expect(events.map((event) => event.kind)).toEqual(["pull_request_mismatch"]);
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
    async bind_verified() { return { ok: true as const, value: "00000000-0000-4000-8000-000000000025" as PullRequestVerificationId }; },
  } as unknown as DevFlowPullRequestRepository;
  const replacement = observation({ number: 441, url: "https://github.com/RankOneLabs/oakridge/pull/441",
    state: "open", merged_at: null, head_sha: "new-head" });
  const result = await verifyAndBindCohortPullRequest({ pull_requests: repository,
    reader: { async read() { return replacement; } },
    git: { async run() { return { exit_code: 0, stdout: "new-head\trefs/heads/cohort/foundation\n", stderr: "" }; } },
    now: () => "2026-09-29T01:00:00Z", async record_build_event(_id, event) { events.push(event); } }, {
    cohort, forge_repository: { owner: "RankOneLabs", name: "oakridge" }, candidate_url: replacement.url,
    replace_verification_id: cohort.current_verified_pull_request_id,
  });
  expect(result.ok && result.value.binding).toBe("replaced");
  expect(events.map((event) => event.kind)).toEqual(["replacement_pull_request_required", "pull_request_verified"]);
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
    now: () => "2026-09-29T01:00:00Z", async record_build_event() {} }, {
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
    forge_targets: { async find() { return { forge_repository: { owner: "RankOneLabs", name: "oakridge" } }; } } as never,
    records: { async find_cohort_handoff() { return { run_id: expected.run_id, stage_instance_id: expected.stage_instance_id,
      unit_id: expected.unit_id, repository_key: "oakridge", handoff_artifact_id: firstHandoffId,
      handoff_slot_state: "pending", handoff_body: {} }; },
    async find_cohort_state() { return { run_id: expected.run_id, stage_instance_id: expected.stage_instance_id,
      cohort_key: expected.unit_id }; } } as never,
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
      async create_cohort(cohort: DevFlowBuildCohort) { stored = cohort; return cohort; },
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

/* ------------------------------------------------------------------ *
 * The build gate's own verification producer
 * ------------------------------------------------------------------ */

const PR_440 = "00000000-0000-4000-8000-000000000031" as PullRequestId;
const PR_441 = "00000000-0000-4000-8000-000000000032" as PullRequestId;
const VERIFICATION = "00000000-0000-4000-8000-000000000033" as PullRequestVerificationId;

/** A reporting fixture: what the cohort already has, and what the forge says now. */
interface ReportedFixture {
  readonly cohort: DevFlowBuildCohort;
  readonly current: { readonly pull_request_id: PullRequestId; readonly url: string; readonly head_sha: string } | null;
  readonly forge: PullRequestObservation;
  readonly stored_pull_request_id: PullRequestId;
  readonly pushed_head_sha: string;
  readonly forge_target?: boolean;
}

const reportedDependencies = (fixture: ReportedFixture) => {
  const events: ReportedBuildCohortEvent[] = [];
  const replacements: (PullRequestVerificationId | null)[] = [];
  const pull_requests = {
    async find_cohort_for_unit() { return fixture.cohort; },
    async find_current_for_unit() {
      if (!fixture.current) return null;
      return { cohort: fixture.cohort,
        pull_request: { id: fixture.current.pull_request_id, provider: "github" as const, owner: "RankOneLabs",
          name: "oakridge", forge_pull_request_id: 440, url: fixture.current.url, created_at: "2026-09-29T00:00:00Z" },
        observation: { ...observation({ state: "open", merged_at: null, head_sha: fixture.current.head_sha }),
          id: "00000000-0000-4000-8000-000000000034" as PullRequestObservationId,
          pull_request_id: fixture.current.pull_request_id, recorded_at: "2026-09-29T00:00:00Z" } };
    },
    async observe() { return { pull_request_id: fixture.stored_pull_request_id,
      observation_id: "00000000-0000-4000-8000-000000000035" as PullRequestObservationId }; },
    async bind_verified(input: { readonly replace_verification_id: PullRequestVerificationId | null }) {
      replacements.push(input.replace_verification_id);
      if (fixture.cohort.current_verified_pull_request_id !== null && input.replace_verification_id === null) {
        return { ok: false as const, error: { kind: "replacement_required" as const, detail: "replacement must name it" } };
      }
      return { ok: true as const, value: "00000000-0000-4000-8000-000000000036" as PullRequestVerificationId };
    },
  } as unknown as DevFlowPullRequestRepository;
  return { events, replacements, dependencies: {
    pull_requests,
    forge_targets: { async find() { return fixture.forge_target === false ? null
      : { forge_repository: { owner: "RankOneLabs", name: "oakridge" } }; } } as never,
    reader: { async read() { return fixture.forge; } },
    git: { async run() { return { exit_code: 0, stdout: `${fixture.pushed_head_sha}\trefs/heads/cohort/foundation\n`, stderr: "" }; } },
    now: () => "2026-09-29T02:00:00Z",
    async record_build_event(_id: CohortId, event: ReportedBuildCohortEvent) { events.push(event); },
  } };
};

const reportedInput = (candidate_url: string | null) => ({
  stage_instance_id: expected.stage_instance_id, unit_id: expected.unit_id,
  run_id: expected.run_id, candidate_url,
});

/**
 * The bootstrap. Nothing else produces a build cohort's first
 * `pull_request_verified`: the merge poller sweeps cohorts blocked on the
 * external wait, two gates further on.
 */
test("a reported pull request URL is verified at publication and told to the machine", async () => {
  const fixture = reportedDependencies({
    cohort: storedCohort("/repo", "head-1"), current: null,
    forge: observation({ state: "open", merged_at: null, head_sha: "head-1" }),
    stored_pull_request_id: PR_440, pushed_head_sha: "head-1",
  });
  const outcome = await verifyReportedCohortPullRequest(fixture.dependencies, reportedInput(expected.url));
  expect(outcome).toEqual({ kind: "verified", pull_request_url: expected.url, binding: "created" });
  expect(fixture.events).toEqual([{ kind: "pull_request_verified", head_sha: "head-1", pull_request_url: expected.url }]);
});

/**
 * Every publication after the first re-reports the same pull request with more
 * commits on it. Calling that a replacement restarted the builder and threw the
 * verification away, so the gate could never stay open.
 */
test("re-reporting the same pull request at a new head rebinds rather than demands a replacement", async () => {
  const fixture = reportedDependencies({
    cohort: { ...storedCohort("/repo", "head-2"), current_verified_pull_request_id: VERIFICATION },
    current: { pull_request_id: PR_440, url: expected.url, head_sha: "head-1" },
    forge: observation({ state: "open", merged_at: null, head_sha: "head-2" }),
    stored_pull_request_id: PR_440, pushed_head_sha: "head-2",
  });
  const outcome = await verifyReportedCohortPullRequest(fixture.dependencies, reportedInput(expected.url));
  expect(outcome).toEqual({ kind: "verified", pull_request_url: expected.url, binding: "rebound" });
  expect(fixture.replacements).toEqual([VERIFICATION]);
  expect(fixture.events.map((event) => event.kind)).toEqual(["pull_request_verified"]);
});

test("a different pull request URL is refused as the replacement it is", async () => {
  const replacement = observation({ number: 441, url: "https://github.com/RankOneLabs/oakridge/pull/441",
    state: "open", merged_at: null, head_sha: "head-2" });
  const fixture = reportedDependencies({
    cohort: { ...storedCohort("/repo", "head-2"), current_verified_pull_request_id: VERIFICATION },
    current: { pull_request_id: PR_440, url: expected.url, head_sha: "head-1" },
    forge: replacement, stored_pull_request_id: PR_441, pushed_head_sha: "head-2",
  });
  const outcome = await verifyReportedCohortPullRequest(fixture.dependencies, reportedInput(replacement.url));
  expect(outcome).toEqual({ kind: "refused", detail: expect.stringContaining("replacement") });
  expect(fixture.replacements).toEqual([null]);
  expect(fixture.events.map((event) => event.kind)).toEqual(["replacement_pull_request_required"]);
});

test("a publication that reports no pull request, on a cohort with none, records nothing", async () => {
  const fixture = reportedDependencies({
    cohort: storedCohort("/repo", "head-1"), current: null,
    forge: observation({ state: "open", merged_at: null, head_sha: "head-1" }),
    stored_pull_request_id: PR_440, pushed_head_sha: "head-1",
  });
  expect(await verifyReportedCohortPullRequest(fixture.dependencies, reportedInput(null))).toEqual({ kind: "no_candidate" });
  expect(fixture.events).toEqual([]);
});

test("a repository with no forge identity is not applicable rather than a mismatch", async () => {
  const fixture = reportedDependencies({
    cohort: storedCohort("/repo", "head-1"), current: null,
    forge: observation({ state: "open", merged_at: null, head_sha: "head-1" }),
    stored_pull_request_id: PR_440, pushed_head_sha: "head-1", forge_target: false,
  });
  expect(await verifyReportedCohortPullRequest(fixture.dependencies, reportedInput(expected.url)))
    .toEqual({ kind: "not_applicable", detail: expect.stringContaining("forge identity") });
  expect(fixture.events).toEqual([]);
});

/* ------------------------------------------------------------------ *
 * Completing a cohort on a merge, without a handoff wait
 * ------------------------------------------------------------------ */

/**
 * `dev_flow_v15` declares gates and no handoffs, so `find_cohort_handoff` returns
 * null for every cohort in it. Reconciliation used to require that record and
 * refused with `cohort_not_found` before reaching a single check — so neither the
 * merge poller nor the operator's confirm-merged button could complete a cohort,
 * and every one of them parked in `awaiting_merge` after assessment approval.
 */
const mergedFixture = (overrides: { readonly handoff?: boolean } = {}) => {
  const merged = observation({ state: "merged", merged_at: "2026-09-29T03:00:00.000Z",
    observed_at: "2026-09-29T03:01:00.000Z", head_sha: "merged-head", source: "poll" });
  const cohort = { ...storedCohort("/repo", "merged-head"), current_verified_pull_request_id: VERIFICATION };
  const events: ReportedBuildCohortEvent[] = [];
  const closures: string[] = [];
  const wakes: string[] = [];
  const pull_requests = {
    async find_cohort_for_unit() { return cohort; },
    async find_current_for_unit() {
      return { cohort, pull_request: { id: PR_440, provider: "github" as const, owner: "RankOneLabs",
        name: "oakridge", forge_pull_request_id: 440, url: expected.url, created_at: "2026-09-29T00:00:00Z" },
      observation: { ...merged, id: "00000000-0000-4000-8000-000000000037" as PullRequestObservationId,
        pull_request_id: PR_440, recorded_at: "2026-09-29T03:01:00.000Z" } };
    },
    async observe() { return { pull_request_id: PR_440,
      observation_id: "00000000-0000-4000-8000-000000000038" as PullRequestObservationId }; },
    async bind_verified() { return { ok: true as const, value: VERIFICATION }; },
    async confirm_merge(input: { readonly idempotency_key: string }) {
      closures.push(input.idempotency_key);
      return { ok: true as const, value: { kind: "created" as const, closure: {} } };
    },
  } as unknown as DevFlowPullRequestRepository;
  return { events, closures, wakes, merged, cohort, dependencies: {
    pull_requests,
    forge_targets: { async find() { return { forge_repository: { owner: "RankOneLabs", name: "oakridge" } }; } } as never,
    reader: { async read() { return merged; } },
    git: { async run() { return { exit_code: 0, stdout: "merged-head\trefs/heads/cohort/foundation\n", stderr: "" }; } },
    records: {
      async find_cohort_handoff() {
        return overrides.handoff === true ? { run_id: expected.run_id, stage_instance_id: expected.stage_instance_id,
          unit_id: expected.unit_id, repository_key: "oakridge", handoff_artifact_id: firstHandoffId,
          handoff_slot_state: "pending", handoff_body: {} } : null;
      },
      async find_cohort_state() { return { run_id: expected.run_id, stage_instance_id: expected.stage_instance_id,
        cohort_key: expected.unit_id }; },
      async complete_handoff_artifact() { return { kind: "released" as const, artifact_id: firstHandoffId,
        run_id: expected.run_id, cohort_id: cohort.cohort_id, record_version: 9 }; },
    } as never,
    now: () => "2026-09-29T03:02:00.000Z",
    async record_build_event(_id: CohortId, event: ReportedBuildCohortEvent) { events.push(event); },
    async send_run_wake(_run: WorkflowRunId, key: string) { wakes.push(key); },
  } };
};

test("a merged cohort with no handoff is completed by telling its machine", async () => {
  const fixture = mergedFixture();
  const result = await reconcileCohortEvidence(fixture.dependencies as never,
    expected.stage_instance_id, expected.unit_id, { kind: "observation", observation: fixture.merged, replace_verification_id: null });
  expect(result.ok && result.value.resolution).toEqual({ kind: "completed" });
  expect(fixture.events.map((event) => event.kind)).toEqual(["pull_request_verified", "pull_request_merged"]);
  expect(fixture.events.at(-1)).toEqual({ kind: "pull_request_merged", pull_request_url: expected.url });
  expect(fixture.closures).toEqual([`forge:${PR_440}:${fixture.merged.merged_at}`]);
  expect(fixture.wakes).toHaveLength(1);
});

test("an operator confirmation completes the same way and carries its own idempotency key", async () => {
  const fixture = mergedFixture();
  const result = await reconcileCohortEvidence(fixture.dependencies as never,
    expected.stage_instance_id, expected.unit_id,
    { kind: "operator_confirmation", idempotency_key: "operator-merge-1", operator_comment: "merged by hand" });
  expect(result.ok && result.value.resolution).toEqual({ kind: "completed" });
  expect(fixture.closures).toEqual(["operator-merge-1"]);
  expect(fixture.events.at(-1)).toEqual({ kind: "pull_request_merged", pull_request_url: expected.url });
});

/** A definition that does declare a handoff still has its wait closed. */
test("a declared handoff wait is still closed alongside the machine event", async () => {
  const fixture = mergedFixture({ handoff: true });
  const result = await reconcileCohortEvidence(fixture.dependencies as never,
    expected.stage_instance_id, expected.unit_id, { kind: "observation", observation: fixture.merged, replace_verification_id: null });
  expect(result.ok && result.value.resolution).toEqual({ kind: "completed" });
  expect(fixture.events.at(-1)).toEqual({ kind: "pull_request_merged", pull_request_url: expected.url });
});
