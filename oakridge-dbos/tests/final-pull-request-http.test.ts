import { expect, test } from "bun:test";

import type { EpicWorkflowProfile, EpicWorkflowProfileId } from "../src/domain/epic";
import type { CohortId, StageInstanceId, WorkflowRunId } from "../src/domain/primitives";
import type { PullRequestId, PullRequestMergeClosureId, PullRequestObservationId, PullRequestVerificationId } from "../src/domain/pull-request";
import type { DevFlowPullRequestRepository, FinalPullRequestRepository } from "../src/storage/repositories";
import { createFinalPullRequestApp, type FinalPullRequestHttpDependencies } from "../src/http/final-pull-request";
import { createApp, type OakridgeHttpDependencies } from "../src/http/app";

const runId = "11111111-1111-4111-8111-111111111111" as WorkflowRunId;
const cohortId = "22222222-2222-4222-8222-222222222222" as CohortId;
const stageInstanceId = "33333333-3333-4333-8333-333333333333" as StageInstanceId;
const pullRequestId = "44444444-4444-4444-8444-444444444444" as PullRequestId;
const observationId = "55555555-5555-4555-8555-555555555555" as PullRequestObservationId;
const verificationId = "66666666-6666-4666-8666-666666666666" as PullRequestVerificationId;

const profile: EpicWorkflowProfile = {
  id: "profile-1" as EpicWorkflowProfileId, workflow_run_id: runId,
  title: "Epic", slug: "epic", lifecycle_state: "final_integration", final_merge_policy: "external_confirmation",
  repositories: [], created_at: "2026-08-15T00:00:00Z", updated_at: "2026-08-15T00:00:00Z",
};

const observation = {
  provider: "github" as const, owner: "acme", name: "api", number: 42,
  url: "https://github.com/acme/api/pull/42", head_branch: "epic/work", base_branch: "main",
  head_sha: "abc", state: "merged" as const, source: "poll" as const,
  observed_at: "2026-08-15T01:00:00Z", merged_at: "2026-08-15T01:00:00Z",
};

const target = {
  cohort: { cohort_id: cohortId, stage_instance_id: stageInstanceId, cohort_key: "api", repository_key: "api",
    repository_path: "/repos/api", canonical_ref: "epic/work", expected_pr_base: "main", recorded_head_sha: "abc",
    current_verified_pull_request_id: verificationId, created_at: "2026-08-15T00:00:00Z", updated_at: "2026-08-15T00:00:00Z" },
  forge_repository: { owner: "acme", name: "api" },
};

const current = {
  cohort: target.cohort,
  pull_request: { id: pullRequestId, repository_key: "api", provider: "github" as const, owner: "acme", name: "api",
    forge_pull_request_id: 42, url: observation.url, created_at: "2026-08-15T00:00:00Z" },
  observation: { ...observation, id: observationId, pull_request_id: pullRequestId, recorded_at: "2026-08-15T01:00:01Z" },
};

const dependencies = (finalPullRequests: FinalPullRequestRepository, existing: typeof current | null = null): FinalPullRequestHttpDependencies => {
  const pullRequests: DevFlowPullRequestRepository = {
    async find_cohort_for_unit() { return target.cohort; },
    async find_current_for_unit() { return existing; },
    async observe() { return { pull_request_id: pullRequestId, observation_id: observationId }; },
    async bind_verified() { return { ok: true, value: verificationId }; },
    async confirm_merge(input) { return { ok: true, value: { kind: "created", closure: { id: "77777777-7777-4777-8777-777777777777" as PullRequestMergeClosureId,
      cohort_id: input.cohort_id, pull_request_id: input.pull_request_id, idempotency_key: input.idempotency_key,
      merged_at: input.merged_at, confirmed_at: input.confirmed_at } } }; },
  };
  return {
    final_pull_requests: finalPullRequests, pull_requests: pullRequests,
    final_targets: { async find() { return target; } },
    pull_request_reader: { async read() { return observation; } },
    git: { async run() { return { exit_code: 0, stdout: "abc\trefs/heads/epic/work\n", stderr: "" }; } },
    now: () => "2026-08-15T02:00:00Z",
  };
};

test("final pull request HTTP independently verifies and persists through the shared PR entity", async () => {
  const received: Parameters<FinalPullRequestRepository["observe"]>[0][] = [];
  const repository: FinalPullRequestRepository = {
    async observe(input) { received.push(input); return { ok: true, value: { outcome: "awaiting_external_confirmation", profile, reconciliation: null } }; },
    async confirm() { throw new Error("not called"); },
  };
  const app = createFinalPullRequestApp(dependencies(repository));
  const response = await app.request(`/workflow_runs/${runId}/final_pull_requests/api/observations`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pull_request_url: observation.url }),
  });
  expect(response.status).toBe(200);
  expect(received).toEqual([{ run_id: runId, repository_key: "api", observation, updated_at: "2026-08-15T02:00:00Z" }]);
  expect(await response.json()).toEqual({ outcome: "awaiting_external_confirmation", profile });
});

test("final confirmation closes the shared merge entity before projecting workflow state", async () => {
  const received: Parameters<FinalPullRequestRepository["confirm"]>[0][] = [];
  const repository: FinalPullRequestRepository = {
    async observe() { throw new Error("not called"); },
    async confirm(input) { received.push(input); return { ok: true, value: { outcome: "completed", profile, reconciliation: null } }; },
  };
  const app = createFinalPullRequestApp(dependencies(repository, current));
  const response = await app.request(`/workflow_runs/${runId}/final_pull_requests/api/confirm`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotency_key: "confirm-42", operator_comment: "verified" }),
  });
  expect(response.status).toBe(200);
  expect(received).toEqual([{ run_id: runId, repository_key: "api", request: { idempotency_key: "confirm-42", operator_comment: "verified" }, confirmed_at: "2026-08-15T02:00:00Z" }]);
});

test("final pull request HTTP rejects malformed observation input", async () => {
  const repository: FinalPullRequestRepository = { async observe() { throw new Error("not called"); }, async confirm() { throw new Error("not called"); } };
  const app = createFinalPullRequestApp(dependencies(repository, current));
  const malformed = await app.request(`/workflow_runs/${runId}/final_pull_requests/api/observations`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ observation: { provider: "github" } }),
  });
  expect(malformed.status).toBe(400);
});

test("the production composed router mounts the final confirmation path", async () => {
  const repository: FinalPullRequestRepository = {
    async observe() { throw new Error("not called"); },
    async confirm() { return { ok: true, value: { outcome: "completed", profile, reconciliation: null } }; },
  };
  const app = createApp({ configuration: {}, admission: {}, operator_retry: {}, run_lifecycle: {}, domain_reads: {},
    final_pull_requests: dependencies(repository, current), artifact_callback: {}, artifact_withdraw: {}, gate_resume: {},
    handoff_complete: {}, collaboration: {}, operator_projections: {}, artifact_detail: {}, run_launch: {}, rerun: {},
  } as unknown as OakridgeHttpDependencies);
  const response = await app.request(`/workflow_runs/${runId}/final_pull_requests/api/confirm`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotency_key: "confirm-42" }),
  });
  expect(response.status).toBe(200);
});
