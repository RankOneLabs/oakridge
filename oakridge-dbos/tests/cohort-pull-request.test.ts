import { expect, test } from "bun:test";

import {
  type CohortRepositoryRecord,
} from "../src/domain/cohort-pull-request";
import { invalidatePullRequestForReplacement, type PullRequestApproval, type PullRequestObservation, type PullRequestObservationId, type PullRequestId, type PullRequestVerificationId, type VerifiedPullRequestLink } from "../src/domain/pull-request";
import type { CohortId, StageInstanceId, UnitId, WorkflowRunId } from "../src/domain/primitives";
import { renderCohortBranchContract, selectCohortBranchRoles } from "../src/domain/repository-refs";
import { prepareCohortRepositoryRecord, verifyAndBindCohortPullRequest, verifyCohortPullRequest } from "../src/runtime/cohort-pull-request";
import { BunGitCommandRunner } from "../src/runtime/git-command-runner";
import type { DevFlowPullRequestRepository } from "../src/storage/repositories";
import { createCohortPullRequestApp } from "../src/http/cohort-pull-request";
import { createGitRepositoryFixture } from "./support/dev-flow-harness";

const expected = {
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

const storedCohort = (repositoryPath: string, head: string): CohortRepositoryRecord => ({
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

test("cohort HTTP refresh returns the state observed from GitHub", async () => {
  const cohort_id = "00000000-0000-4000-8000-000000000020";
  const app = createCohortPullRequestApp({ async refresh() { return { ok: true, value: { state: "awaiting_merge" } }; } });
  const response = await app.request(`/cohorts/${cohort_id}/pull_request/refresh`, { method: "POST" });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ state: "awaiting_merge" });
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
    let stored: CohortRepositoryRecord | null = null;
    const repository = {
      async find_cohort_for_unit() { return stored; },
      async create_cohort(cohort: CohortRepositoryRecord) { stored = cohort; return { ok: true, value: cohort }; },
    } as unknown as DevFlowPullRequestRepository;
    const baseHead = await fixture.origin_branch_sha(fixture.integration_branch);
    if (!baseHead) throw new Error("fixture integration branch is missing");
    const result = await prepareCohortRepositoryRecord({ pull_requests: repository, git: new BunGitCommandRunner() }, {
      cohort_id: storedCohort(fixture.path, baseHead).cohort_id, stage_instance_id: expected.stage_instance_id,
      cohort_key: "foundation", repository: { repository_key: "oakridge", repository_path: fixture.path,
        integration_branch: fixture.integration_branch, base_branch: fixture.integration_branch, base_head_sha: baseHead },
      prepared_at: "2026-09-29T00:00:00Z",
    });
    expect(result.ok).toBe(true);
    expect(stored).toEqual(expect.objectContaining({ canonical_ref: canonicalRef, expected_pr_base: fixture.integration_branch }));
    expect(result.ok && result.value.branch_contract).toContain(`Canonical cohort ref: ${canonicalRef}`);
    expect(await fixture.origin_branch_sha(canonicalRef)).toBe(baseHead);
  } finally {
    await fixture.remove();
  }
});

test("cohort preparation recreates a missing owned ref from the recorded SHA", async () => {
  const cohort = { ...storedCohort("/repo", "old-head"), canonical_ref: `cohort/${expected.stage_instance_id}/foundation` };
  const repository = { async find_cohort_for_unit() { return cohort; } } as unknown as DevFlowPullRequestRepository;
  const commands: string[][] = [];
  const git = { async run(_path: string, args: readonly string[]) {
    commands.push([...args]); return { exit_code: 0, stdout: "", stderr: "" };
  } };
  const result = await prepareCohortRepositoryRecord({ pull_requests: repository, git }, {
    cohort_id: cohort.cohort_id, stage_instance_id: cohort.stage_instance_id, cohort_key: cohort.cohort_key,
    repository: { repository_key: cohort.repository_key, repository_path: cohort.repository_path,
      integration_branch: "main", base_branch: cohort.expected_pr_base, base_head_sha: cohort.recorded_head_sha },
    prepared_at: "2026-09-29T00:00:00Z",
  });
  expect(result.ok && result.value.worktree_base_sha).toBe("old-head");
  expect(commands).toContainEqual(["push", `--force-with-lease=refs/heads/${cohort.canonical_ref}:`, "origin",
    `old-head:refs/heads/${cohort.canonical_ref}`]);
});

for (const crash_point of ["before_push", "after_push"] as const) test(`cohort preparation recovers ${crash_point} using its stored ownership`, async () => {
  const fixture = await createGitRepositoryFixture();
  try {
    const canonicalRef = `cohort/${expected.stage_instance_id}/foundation`;
    let stored: CohortRepositoryRecord | null = null;
    const repository = {
      async find_cohort_for_unit() { return stored; },
      async create_cohort(cohort: CohortRepositoryRecord) { stored ??= cohort; return { ok: true, value: stored }; },
    } as unknown as DevFlowPullRequestRepository;
    const baseHead = (await fixture.origin_branch_sha(fixture.integration_branch))!;
    const input = { cohort_id: storedCohort(fixture.path, baseHead).cohort_id, stage_instance_id: expected.stage_instance_id,
      cohort_key: "foundation", repository: { repository_key: "oakridge", repository_path: fixture.path,
        integration_branch: fixture.integration_branch, base_branch: fixture.integration_branch, base_head_sha: baseHead },
      prepared_at: "2026-10-03T00:00:00Z" };
    const git = new BunGitCommandRunner();
    const crashing = { async run(path: string, args: readonly string[]) {
      if (args[0] === "push") {
        expect(stored).toMatchObject({ recorded_head_sha: baseHead, canonical_ref: canonicalRef });
        if (crash_point === "after_push") expect((await git.run(path, args)).exit_code).toBe(0);
        throw new Error("simulated process crash");
      }
      return git.run(path, args);
    } };
    await expect(prepareCohortRepositoryRecord({ pull_requests: repository, git: crashing }, input)).rejects.toThrow("simulated process crash");
    // The run base moves while the process is down; preparation must keep its pinned SHA.
    await fixture.advance_origin_branch(fixture.integration_branch, "later base");
    const recovered = await prepareCohortRepositoryRecord({ pull_requests: repository, git }, input);
    expect(recovered.ok && recovered.value.worktree_base_sha).toBe(baseHead);
    expect(await fixture.origin_branch_sha(canonicalRef)).toBe(baseHead);
  } finally { await fixture.remove(); }
});

test("cohort preparation leaves an unowned origin ref untouched", async () => {
  const fixture = await createGitRepositoryFixture();
  try {
    const git = new BunGitCommandRunner();
    const canonicalRef = `cohort/${expected.stage_instance_id}/foundation`;
    const baseHead = (await fixture.origin_branch_sha(fixture.integration_branch))!;
    await git.run(fixture.path, ["push", "origin", `${baseHead}:refs/heads/${canonicalRef}`]);
    const repository = { async find_cohort_for_unit() { return null; },
      async create_cohort() { throw new Error("must not adopt an unowned ref"); } } as unknown as DevFlowPullRequestRepository;
    expect(await prepareCohortRepositoryRecord({ pull_requests: repository, git }, {
      cohort_id: storedCohort(fixture.path, baseHead).cohort_id, stage_instance_id: expected.stage_instance_id,
      cohort_key: "foundation", repository: { repository_key: "oakridge", repository_path: fixture.path,
        integration_branch: fixture.integration_branch, base_branch: fixture.integration_branch, base_head_sha: baseHead },
      prepared_at: "2026-10-03T00:00:00Z",
    })).toMatchObject({ ok: false, error: { kind: "ref_lease_mismatch" } });
    expect(await fixture.origin_branch_sha(canonicalRef)).toBe(baseHead);
  } finally { await fixture.remove(); }
});

test("a failed GitHub refresh returns unavailable instead of stale success", async () => {
  const app = createCohortPullRequestApp({ async refresh(cohort_id) {
    return { ok: false, error: { operation: "refresh_pull_request", cohort_id, detail: "GitHub is unavailable" } };
  } });
  const response = await app.request("/cohorts/00000000-0000-4000-8000-000000000001/pull_request/refresh", { method: "POST" });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "GitHub is unavailable" });
});

test("origin ancestry reads remain consistent while the agent advances its branch", async () => {
  const fixture = await createGitRepositoryFixture();
  try {
    const initial = await fixture.origin_branch_sha(fixture.integration_branch);
    const advancing = fixture.advance_origin_branch(fixture.integration_branch, "concurrent build");
    const parents = await Promise.all(Array.from({ length: 20 }, () => fixture.origin_branch_parent_sha(fixture.integration_branch)));
    await advancing;
    expect(parents.every((parent) => parent === null || parent === initial)).toBe(true);
    expect(await fixture.origin_branch_parent_sha(fixture.integration_branch)).toBe(initial);
  } finally { await fixture.remove(); }
});

test("a dependent branch fetches a merge commit created only on origin", async () => {
  const fixture = await createGitRepositoryFixture();
  const git = new BunGitCommandRunner();
  try {
    const oldHead = await fixture.origin_branch_sha(fixture.integration_branch);
    if (!oldHead) throw new Error("fixture has no head");
    const tree = await git.run(fixture.origin_path, ["rev-parse", `${oldHead}^{tree}`]);
    const commit = Bun.spawn(["git", "commit-tree", tree.stdout.trim(), "-p", oldHead, "-m", "external merge"], {
      cwd: fixture.origin_path, stdout: "pipe", stderr: "pipe", env: { ...process.env,
        GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@invalid", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@invalid" },
    });
    const newHead = (await new Response(commit.stdout).text()).trim();
    if (await commit.exited !== 0) throw new Error(await new Response(commit.stderr).text());
    await git.run(fixture.origin_path, ["update-ref", `refs/heads/${fixture.integration_branch}`, newHead]);
    expect((await git.run(fixture.path, ["cat-file", "-e", newHead])).exit_code).not.toBe(0);
    const repository = { async find_cohort_for_unit() { return null; },
      async create_cohort(value: CohortRepositoryRecord) { return { ok: true, value }; } } as unknown as DevFlowPullRequestRepository;
    const result = await prepareCohortRepositoryRecord({ git, pull_requests: repository }, {
      cohort_id: storedCohort(fixture.path, oldHead).cohort_id, stage_instance_id: expected.stage_instance_id, cohort_key: "foundation",
      repository: { repository_key: "oakridge", repository_path: fixture.path, integration_branch: fixture.integration_branch,
        base_branch: fixture.integration_branch, base_head_sha: oldHead }, prepared_at: "2026-10-02T00:00:00Z",
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.worktree_base_sha).toBe(newHead);
    expect(await fixture.origin_branch_sha(`cohort/${expected.stage_instance_id}/foundation`)).toBe(newHead);
  } finally { await fixture.remove(); }
});

for (const state of ["merged", "open", "closed_unmerged"] as const)
  test(`a deleted head branch ${state === "merged" ? "retains a verified merge" : `refuses an ${state} PR`}`, async () => {
    const result = await verifyCohortPullRequest({
      reader: { async read() { return observation({ state, merged_at: state === "merged" ? "2026-08-18T11:59:00Z" : null }); } },
      git: { async run() { return { exit_code: 0, stdout: "", stderr: "" }; } },
    }, { cohort: storedCohort("/repo", "abc123"), forge_repository: { owner: "RankOneLabs", name: "oakridge" }, candidate_url: expected.url });
    expect(result.ok).toBe(state === "merged");
  });
