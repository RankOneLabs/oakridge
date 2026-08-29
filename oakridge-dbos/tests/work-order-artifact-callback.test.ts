import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { createWorkOrderArtifactCallbackApp } from "../src/http/work-order-artifact-callback";
import type { PublishWorkOrderArtifact } from "../src/domain/run-record";
import type { RunRecordVersion } from "../src/domain/primitives";

const workOrderId = "11111111-1111-4111-8111-111111111111";

test("a work-order capability, not mutable session identity, authorizes publication", async () => {
  let published: PublishWorkOrderArtifact | null = null;
  const app = createWorkOrderArtifactCallbackApp({ records: { publish_immediate: async (request) => {
    published = request;
    return { kind: "published", artifact_id: request.artifact_id, record_version: 4 as RunRecordVersion };
  } }, now: () => "2026-08-28T12:00:00.000Z" });
  const response = await app.request(`/work-orders/${workOrderId}/emit/result`, { method: "PUT", headers: {
    "content-type": "application/json", "work-order-capability": "secret", "idempotency-key": "emit-1",
  }, body: JSON.stringify({ complete: true }) });
  expect(response.status).toBe(201);
  expect(published).toEqual(expect.objectContaining({ work_order_id: workOrderId, output_name: "result", idempotency_key: "emit-1",
    capability_hash: createHash("sha256").update("secret").digest("hex") }));
});

test("publication without its work-order capability never reaches the domain command", async () => {
  let calls = 0;
  const app = createWorkOrderArtifactCallbackApp({ records: { publish_immediate: async () => {
    calls += 1;
    throw new Error("unexpected");
  } }, now: () => "2026-08-28T12:00:00.000Z" });
  const response = await app.request(`/work-orders/${workOrderId}/emit/result`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" });
  expect(response.status).toBe(401);
  expect(calls).toBe(0);
});
