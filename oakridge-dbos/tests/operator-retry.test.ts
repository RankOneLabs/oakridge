import { expect, test } from "bun:test";

import { createOperatorRetryApp } from "../src/http/operator-retry";
import type { RetryRunUnitResult } from "../src/domain/run-record";
import type { RunUnitId } from "../src/domain/primitives";

const runUnitId = "00000000-0000-4000-8000-000000000001" as RunUnitId;
const request = (result: RetryRunUnitResult, headers: Record<string, string> = { "Idempotency-Key": "retry-1" }) => {
  let received: unknown;
  const app = createOperatorRetryApp({ records: { retry_unit: async (input) => { received = input; return result; } }, now: () => "2026-08-29T00:00:00Z" });
  return { response: app.request(`/run-units/${runUnitId}/retry`, { method: "PUT", headers }), received: () => received };
};

test("operator retry forwards the durable unit and idempotency identity", async () => {
  const workOrder = { id: "00000000-0000-4000-8000-000000000002", run_unit_id: runUnitId, reason: "operator_retry", input_snapshot: [], input_fingerprint: "input", state: "available", workflow_id: "v2-work:retry", request_idempotency_key: "operator_retry:retry-1", created_at: "2026-08-29T00:00:00Z", completed_at: null } as const;
  const call = request({ kind: "created", work_order: workOrder as never, run_id: "00000000-0000-4000-8000-000000000003" as never, record_version: 2 as never });
  expect((await call.response).status).toBe(202);
  expect(call.received()).toEqual({ run_unit_id: runUnitId, idempotency_key: "retry-1", actor: "operator" });
});

test("operator retry maps replay, missing work, and malformed identity", async () => {
  const replay = request({ kind: "no_missing_work", detail: "nothing missing" });
  expect((await replay.response).status).toBe(409);
  expect((await (await replay.response).json()).kind).toBe("no_missing_work");
  expect((await createOperatorRetryApp({ records: { retry_unit: async () => ({ kind: "unit_not_found", detail: "missing" }) }, now: () => "now" })
    .request("/run-units/not-a-uuid/retry", { method: "PUT", headers: { "Idempotency-Key": "retry" } })).status).toBe(400);
  expect((await request({ kind: "unit_not_found", detail: "missing" }, {}).response).status).toBe(400);
});
