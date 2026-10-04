import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { createWorkOrderArtifactCallbackApp } from "../src/http/work-order-artifact-callback";
import type { PublishWorkOrderArtifact } from "../src/domain/run-record";
import type { CohortId, RunRecordVersion, WorkflowRunId } from "../src/domain/primitives";

const workOrderId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222" as WorkflowRunId;
const cohortId = "33333333-3333-4333-8333-333333333333" as CohortId;

test("a work-order capability, not mutable session identity, authorizes publication", async () => {
  let published: PublishWorkOrderArtifact | null = null;
  const app = createWorkOrderArtifactCallbackApp({ records: { check_artifact_publication: async () => null, publish_artifact: async (request: PublishWorkOrderArtifact) => {
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

test("a refused publication is reported as a 409 with its machine code", async () => {
  const app = createWorkOrderArtifactCallbackApp({ records: { check_artifact_publication: async () => null, publish_artifact: async () =>
    ({ kind: "refused", code: "wrong_state", detail: "publication is not allowed in this state" }) }, now: () => "2026-08-28T12:00:00.000Z" });
  const response = await app.request(`/work-orders/${workOrderId}/emit/plan`, { method: "PUT", headers: {
    "content-type": "application/json", "work-order-capability": "secret", "idempotency-key": "emit-3",
  }, body: JSON.stringify({ draft: true }) });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "publication is not allowed in this state", code: "wrong_state" });
});

test("publication without its work-order capability never reaches the domain command", async () => {
  let calls = 0;
  const app = createWorkOrderArtifactCallbackApp({ records: { check_artifact_publication: async () => null, publish_artifact: async () => {
    calls += 1;
    throw new Error("unexpected");
  } }, now: () => "2026-08-28T12:00:00.000Z" });
  const response = await app.request(`/work-orders/${workOrderId}/emit/result`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" });
  expect(response.status).toBe(401);
  expect(calls).toBe(0);
});


test("a new publication reports enrichment failure without committing", async () => {
  const app = createWorkOrderArtifactCallbackApp({ records: {
    check_artifact_publication: async () => null,
    publish_artifact: async () => { throw new Error("must not commit unavailable enrichment"); },
  }, enrich: async () => ({ ok: false, error: { code: "unavailable", detail: "GitHub unavailable" } }),
  now: () => "2026-08-28T12:00:00.000Z" });
  const response = await app.request(`/work-orders/${workOrderId}/emit/result`, { method: "PUT", headers: {
    "content-type": "application/json", "work-order-capability": "secret",
  }, body: "{}" });
  expect(response.status).toBe(503);
});

test("a mismatched PR observation is refused before publication", async () => {
  const app = createWorkOrderArtifactCallbackApp({ records: {
    check_artifact_publication: async () => null,
    publish_artifact: async () => { throw new Error("must not write an unverified PR"); },
  }, enrich: async () => ({ ok: false, error: { code: "pr_verification_failed", detail: "head branch mismatch" } }),
  now: () => "2026-08-28T12:00:00.000Z" });
  const response = await app.request(`/work-orders/${workOrderId}/emit/pr_summary`, { method: "PUT", headers: {
    "content-type": "application/json", "work-order-capability": "secret",
  }, body: "{}" });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "head branch mismatch", code: "pr_verification_failed" });
});
