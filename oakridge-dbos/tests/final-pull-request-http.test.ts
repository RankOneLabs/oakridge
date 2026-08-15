import { expect, test } from "bun:test";

import type { EpicWorkflowProfile, EpicWorkflowProfileId } from "../src/domain/epic";
import type { FinalPullRequestRepository } from "../src/storage/repositories";
import type { WorkflowRunId } from "../src/domain/primitives";
import { createFinalPullRequestApp } from "../src/http/final-pull-request";
import { createApp, type OakridgeHttpDependencies } from "../src/http/app";

const profile: EpicWorkflowProfile = {
  id: "profile-1" as EpicWorkflowProfileId,
  workflow_run_id: "run-1" as WorkflowRunId,
  title: "Epic", slug: "epic", lifecycle_state: "final_integration", final_merge_policy: "external_confirmation",
  repositories: [], created_at: "2026-08-15T00:00:00Z", updated_at: "2026-08-15T00:00:00Z",
};

const observation = {
  provider: "github" as const, owner: "acme", name: "api", number: 42,
  url: "https://github.com/acme/api/pull/42", head_branch: "epic/work", base_branch: "main",
  head_sha: "abc", state: "merged" as const, source: "webhook" as const,
  observed_at: "2026-08-15T01:00:00Z", merged_at: "2026-08-15T01:00:00Z",
};

test("final pull request HTTP forwards a typed observation and hides internal reconciliation", async () => {
  const received: Parameters<FinalPullRequestRepository["observe"]>[0][] = [];
  const repository: FinalPullRequestRepository = {
    async observe(input) { received.push(input); return { ok: true, value: { outcome: "awaiting_external_confirmation", profile, reconciliation: null } }; },
    async confirm() { throw new Error("not called"); },
  };
  const app = createFinalPullRequestApp({ final_pull_requests: repository, now: () => "2026-08-15T02:00:00Z" });
  const response = await app.request("/workflow_runs/run-1/final_pull_requests/api/observations", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ observation }),
  });

  expect(response.status).toBe(200);
  expect(received).toEqual([{ run_id: "run-1" as WorkflowRunId, repository_key: "api", observation, updated_at: "2026-08-15T02:00:00Z" }]);
  expect(await response.json()).toEqual({ outcome: "awaiting_external_confirmation", profile });
});

test("final pull request confirmation matches the kbbl client contract", async () => {
  const received: Parameters<FinalPullRequestRepository["confirm"]>[0][] = [];
  const repository: FinalPullRequestRepository = {
    async observe() { throw new Error("not called"); },
    async confirm(input) { received.push(input); return { ok: true, value: { outcome: "completed", profile, reconciliation: null } }; },
  };
  const app = createFinalPullRequestApp({ final_pull_requests: repository, now: () => "2026-08-15T02:00:00Z" });
  const response = await app.request("/workflow_runs/run-1/final_pull_requests/api/confirm", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotency_key: "confirm-42", operator_comment: "verified" }),
  });

  expect(response.status).toBe(200);
  expect(received).toEqual([{ run_id: "run-1" as WorkflowRunId, repository_key: "api", request: { idempotency_key: "confirm-42", operator_comment: "verified" }, confirmed_at: "2026-08-15T02:00:00Z" }]);
  expect(await response.json()).toEqual({ outcome: "completed", profile });
});

test("final pull request HTTP distinguishes malformed input from domain conflicts", async () => {
  const repository: FinalPullRequestRepository = {
    async observe() { throw new Error("not called"); },
    async confirm() { return { ok: false, error: { operation: "confirm_final_pull_request", kind: "missing_merged_evidence", detail: "no merged evidence" } }; },
  };
  const app = createFinalPullRequestApp({ final_pull_requests: repository });
  const malformed = await app.request("/workflow_runs/run-1/final_pull_requests/api/observations", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ observation: { provider: "github" } }),
  });
  expect(malformed.status).toBe(400);

  const conflict = await app.request("/workflow_runs/run-1/final_pull_requests/api/confirm", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotency_key: "confirm-42" }),
  });
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({ error: "no merged evidence", code: "missing_merged_evidence" });
});

test("the production composed router mounts the kbbl final confirmation path", async () => {
  const repository: FinalPullRequestRepository = {
    async observe() { throw new Error("not called"); },
    async confirm() { return { ok: true, value: { outcome: "completed", profile, reconciliation: null } }; },
  };
  const app = createApp({
    configuration: {}, admission: {}, run_lifecycle: {}, domain_reads: {},
    final_pull_requests: { final_pull_requests: repository }, artifact_callback: {}, artifact_withdraw: {},
    gate_resume: {}, handoff_complete: {}, collaboration: {}, operator_projections: {}, artifact_detail: {},
    run_launch: {}, rerun: {},
  } as unknown as OakridgeHttpDependencies);
  const response = await app.request("/workflow_runs/run-1/final_pull_requests/api/confirm", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotency_key: "confirm-42" }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ outcome: "completed", profile });
});
