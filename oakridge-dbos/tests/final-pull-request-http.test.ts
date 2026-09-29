import { expect, test } from "bun:test";

import type { BuildCohortEvent } from "../src/adapters/dev-flow-build";
import type { FinalPullRequestEvent } from "../src/domain/final-pull-request";
import type { CohortId, StageInstanceId, WorkflowRunId } from "../src/domain/primitives";
import type { PullRequestId, PullRequestMergeClosure, PullRequestMergeClosureId, PullRequestObservationId, PullRequestVerificationId } from "../src/domain/pull-request";
import { createFinalPullRequestApp, type FinalPullRequestHttpDependencies } from "../src/http/final-pull-request";
import { createApp, type OakridgeHttpDependencies } from "../src/http/app";
import type { DevFlowPullRequestRepository } from "../src/storage/repositories";

const runId = "11111111-1111-4111-8111-111111111111" as WorkflowRunId;
const cohortId = "22222222-2222-4222-8222-222222222222" as CohortId;
const stageInstanceId = "33333333-3333-4333-8333-333333333333" as StageInstanceId;
const pullRequestId = "44444444-4444-4444-8444-444444444444" as PullRequestId;
const observationId = "55555555-5555-4555-8555-555555555555" as PullRequestObservationId;
const verificationId = "66666666-6666-4666-8666-666666666666" as PullRequestVerificationId;

const observation = {
  provider: "github" as const, owner: "acme", name: "api", number: 42,
  url: "https://github.com/acme/api/pull/42", head_branch: "epic/work", base_branch: "main",
  head_sha: "abc", state: "merged" as const, source: "poll" as const,
  observed_at: "2026-08-15T01:00:00Z", merged_at: "2026-08-15T01:00:00Z",
};

const cohort = { cohort_id: cohortId, stage_instance_id: stageInstanceId, cohort_key: "api", repository_key: "api",
  repository_path: "/repos/api", canonical_ref: "epic/work", expected_pr_base: "main", recorded_head_sha: "abc",
  current_verified_pull_request_id: null, created_at: "2026-08-15T00:00:00Z", updated_at: "2026-08-15T00:00:00Z" };

const current = {
  cohort: { ...cohort, current_verified_pull_request_id: verificationId },
  pull_request: { id: pullRequestId, provider: "github" as const, owner: "acme", name: "api",
    forge_pull_request_id: 42, url: observation.url, created_at: "2026-08-15T00:00:00Z" },
  observation: { ...observation, id: observationId, pull_request_id: pullRequestId, recorded_at: "2026-08-15T01:00:01Z" },
};

interface DependencyFixture {
  readonly dependencies: FinalPullRequestHttpDependencies;
  readonly build_events: BuildCohortEvent[];
  readonly final_events: FinalPullRequestEvent[];
}

const dependencyFixture = (existing: typeof current | null = null, mergePolicy: "guarded" | "external_confirmation" = "external_confirmation"): DependencyFixture => {
  let currentValue = existing;
  let closure: PullRequestMergeClosure | null = null;
  const build_events: BuildCohortEvent[] = [];
  const final_events: FinalPullRequestEvent[] = [];
  const pullRequests: DevFlowPullRequestRepository = {
    async create_cohort(value) { return value; },
    async begin_cohort_advance() { return { ok: false, error: { kind: "cohort_not_found", detail: "not used" } }; },
    async advance_cohort_head() { return { ok: false, error: { kind: "cohort_not_found", detail: "not used" } }; },
    async find_cohort_for_unit() { return cohort; },
    async find_current_for_unit() { return currentValue; },
    async observe() { return { pull_request_id: pullRequestId, observation_id: observationId }; },
    async bind_verified() {
      currentValue = current;
      return { ok: true, value: verificationId };
    },
    async confirm_merge(input) {
      if (closure) {
        if (closure.idempotency_key !== input.idempotency_key) return { ok: false, error: { kind: "idempotency_conflict", detail: "different key" } };
        return { ok: true, value: { kind: "replayed", closure } };
      }
      closure = { id: "77777777-7777-4777-8777-777777777777" as PullRequestMergeClosureId,
        cohort_id: input.cohort_id, pull_request_id: input.pull_request_id, idempotency_key: input.idempotency_key,
        merged_at: input.merged_at, confirmed_at: input.confirmed_at };
      return { ok: true, value: { kind: "created", closure } };
    },
  };
  return { build_events, final_events, dependencies: {
    pull_requests: pullRequests,
    final_targets: { async find() { return { cohort, forge_repository: { owner: "acme", name: "api" }, merge_policy: mergePolicy }; } },
    pull_request_reader: { async read() { return observation; } },
    git: { async run() { return { exit_code: 0, stdout: "abc\trefs/heads/epic/work\n", stderr: "" }; } },
    async record_build_event(_cohortId, event) { build_events.push(event); },
    async record_final_event(event) { final_events.push(event); },
    now: () => "2026-08-15T02:00:00Z",
  } };
};

test("final pull request HTTP verifies and binds through the shared PR entity", async () => {
  const fixture = dependencyFixture();
  const app = createFinalPullRequestApp(fixture.dependencies);
  const response = await app.request(`/workflow_runs/${runId}/final_pull_requests/api/observations`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pull_request_url: observation.url }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ outcome: "merged_evidence", pull_request_url: observation.url,
    verification_id: verificationId, binding: "created" });
  expect(fixture.build_events).toEqual([{ kind: "pull_request_verified", revision: "abc", pull_request_url: observation.url }]);
  expect(fixture.final_events[0]).toEqual(expect.objectContaining({ kind: "pull_request_verified", verification_id: verificationId }));
});

test("final confirmation reports a real replay from the shared merge closure", async () => {
  const fixture = dependencyFixture(current);
  const app = createFinalPullRequestApp(fixture.dependencies);
  const request = () => app.request(`/workflow_runs/${runId}/final_pull_requests/api/confirm`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotency_key: "confirm-42", operator_comment: "verified" }),
  });
  const first = await request();
  const replay = await request();
  expect(first.status).toBe(200);
  expect((await first.json()).confirmation).toBe("created");
  expect(replay.status).toBe(200);
  expect((await replay.json()).confirmation).toBe("replayed");
  expect(fixture.final_events.map((event) => event.kind === "pull_request_merge_confirmed" ? event.confirmation : null)).toEqual(["created", "replayed"]);
});

test("guarded final merge policy refuses explicit confirmation", async () => {
  const app = createFinalPullRequestApp(dependencyFixture(current, "guarded").dependencies);
  const response = await app.request(`/workflow_runs/${runId}/final_pull_requests/api/confirm`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotency_key: "confirm-42" }),
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual(expect.objectContaining({ code: "invalid_policy" }));
});

test("final pull request HTTP rejects malformed observation input", async () => {
  const app = createFinalPullRequestApp(dependencyFixture(current).dependencies);
  const malformed = await app.request(`/workflow_runs/${runId}/final_pull_requests/api/observations`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ observation: { provider: "github" } }),
  });
  expect(malformed.status).toBe(400);
});

test("the production composed router mounts the final confirmation path", async () => {
  const dependencies = dependencyFixture(current).dependencies;
  const app = createApp({ configuration: {}, admission: {}, operator_retry: {}, run_lifecycle: {}, domain_reads: {},
    final_pull_requests: dependencies, work_order_artifact_callback: {}, gate_resume: {},
    handoff_complete: {}, cohort_pull_requests: {}, collaboration: {}, operator_projections: {}, artifact_detail: {}, run_launch: {}, rerun: {},
  } as unknown as OakridgeHttpDependencies);
  const response = await app.request(`/workflow_runs/${runId}/final_pull_requests/api/confirm`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotency_key: "confirm-42" }),
  });
  expect(response.status).toBe(200);
});
