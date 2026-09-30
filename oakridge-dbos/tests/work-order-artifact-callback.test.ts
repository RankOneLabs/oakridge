import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { createWorkOrderArtifactCallbackApp } from "../src/http/work-order-artifact-callback";
import type { PublishWorkOrderArtifact } from "../src/domain/run-record";
import type { CohortId, RunRecordVersion, WaitId, WorkflowRunId } from "../src/domain/primitives";

const workOrderId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222" as WorkflowRunId;
const cohortId = "33333333-3333-4333-8333-333333333333" as CohortId;

test("a work-order capability, not mutable session identity, authorizes publication", async () => {
  let published: PublishWorkOrderArtifact | null = null;
  const app = createWorkOrderArtifactCallbackApp({ records: { publish_artifact: async (request: PublishWorkOrderArtifact) => {
    published = request;
    return { kind: "published", artifact_id: request.artifact_id, run_id: runId, cohort_id: cohortId, record_version: 4 as RunRecordVersion };
  } }, now: () => "2026-08-28T12:00:00.000Z" });
  const response = await app.request(`/work-orders/${workOrderId}/emit/result`, { method: "PUT", headers: {
    "content-type": "application/json", "work-order-capability": "secret", "idempotency-key": "emit-1",
  }, body: JSON.stringify({ complete: true }) });
  expect(response.status).toBe(201);
  expect(published).toEqual(expect.objectContaining({ attempt_id: workOrderId, output_name: "result", idempotency_key: "emit-1",
    capability_hash: createHash("sha256").update("secret").digest("hex") }));
});

test("a gated output reports its pending wait rather than a release", async () => {
  const waitId = "88888888-8888-4888-8888-888888888888" as WaitId;
  const app = createWorkOrderArtifactCallbackApp({ records: { publish_artifact: async (request: PublishWorkOrderArtifact) =>
    ({ kind: "pending", artifact_id: request.artifact_id, wait_id: waitId, run_id: runId, cohort_id: cohortId, record_version: 5 as RunRecordVersion }) }, now: () => "2026-08-28T12:00:00.000Z" });
  const response = await app.request(`/work-orders/${workOrderId}/emit/plan`, { method: "PUT", headers: {
    "content-type": "application/json", "work-order-capability": "secret", "idempotency-key": "emit-2",
  }, body: JSON.stringify({ draft: true }) });
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual(expect.objectContaining({ state: "pending", wait_id: waitId, record_version: 5 }));
});

test("a second publish while the slot is already pending is reported as a 409 with the existing wait id", async () => {
  const waitId = "99999999-9999-4999-8999-999999999999" as WaitId;
  const app = createWorkOrderArtifactCallbackApp({ records: { publish_artifact: async () =>
    ({ kind: "slot_pending", wait_id: waitId, detail: "output slot 'plan' is already pending a decision" }) }, now: () => "2026-08-28T12:00:00.000Z" });
  const response = await app.request(`/work-orders/${workOrderId}/emit/plan`, { method: "PUT", headers: {
    "content-type": "application/json", "work-order-capability": "secret", "idempotency-key": "emit-3",
  }, body: JSON.stringify({ draft: true }) });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "output slot 'plan' is already pending a decision", code: "slot_pending", wait_id: waitId });
});

test("publication without its work-order capability never reaches the domain command", async () => {
  let calls = 0;
  const app = createWorkOrderArtifactCallbackApp({ records: { publish_artifact: async () => {
    calls += 1;
    throw new Error("unexpected");
  } }, now: () => "2026-08-28T12:00:00.000Z" });
  const response = await app.request(`/work-orders/${workOrderId}/emit/result`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" });
  expect(response.status).toBe(401);
  expect(calls).toBe(0);
});

/**
 * The publication is where the run learns a build has a pull request, so the
 * header has to reach the verifier — and a verifier that throws must leave the
 * committed publication reported as committed.
 */
test("a reported pull request URL reaches the verifier, and its failure does not undo the publication", async () => {
  const reported: { readonly cohort_id: CohortId; readonly candidate_url: string | null }[] = [];
  const app = createWorkOrderArtifactCallbackApp({
    records: { publish_artifact: async (request: PublishWorkOrderArtifact) =>
      ({ kind: "published", artifact_id: request.artifact_id, run_id: runId, cohort_id: cohortId, record_version: 6 as RunRecordVersion }) },
    now: () => "2026-09-29T12:00:00.000Z",
    verify_reported_pull_request: async (input) => {
      reported.push(input);
      throw new Error("forge is unreachable");
    },
  });
  const response = await app.request(`/work-orders/${workOrderId}/emit/pr_summary`, { method: "PUT", headers: {
    "content-type": "application/json", "work-order-capability": "secret", "idempotency-key": "emit-4",
    "pull-request-url": " https://github.com/RankOneLabs/oakridge/pull/440 ",
  }, body: JSON.stringify({ pr_url: "https://github.com/RankOneLabs/oakridge/pull/440" }) });
  expect(response.status).toBe(201);
  expect(reported).toEqual([{ cohort_id: cohortId, candidate_url: "https://github.com/RankOneLabs/oakridge/pull/440" }]);
});

test("a publication that names no pull request still asks for a recheck of the stored one", async () => {
  const reported: (string | null)[] = [];
  const app = createWorkOrderArtifactCallbackApp({
    records: { publish_artifact: async (request: PublishWorkOrderArtifact) =>
      ({ kind: "published", artifact_id: request.artifact_id, run_id: runId, cohort_id: cohortId, record_version: 7 as RunRecordVersion }) },
    now: () => "2026-09-29T12:00:00.000Z",
    verify_reported_pull_request: async (input) => { reported.push(input.candidate_url); },
  });
  const response = await app.request(`/work-orders/${workOrderId}/emit/build_result`, { method: "PUT", headers: {
    "content-type": "application/json", "work-order-capability": "secret", "idempotency-key": "emit-5",
  }, body: JSON.stringify({ summary: "done" }) });
  expect(response.status).toBe(201);
  expect(reported).toEqual([null]);
});
