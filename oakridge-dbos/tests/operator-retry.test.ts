import { expect, test } from "bun:test";

import { createOperatorRetryApp } from "../src/http/operator-retry";
import type { RetryRunUnitResult } from "../src/domain/run-record";
import type { RunUnitId, StageInstanceId, UnitId } from "../src/domain/primitives";

const runUnitId = "00000000-0000-4000-8000-000000000001" as RunUnitId;
const stageInstanceId = "00000000-0000-4000-8000-000000000004" as StageInstanceId;
const request = (result: RetryRunUnitResult, headers: Record<string, string> = { "Idempotency-Key": "retry-1" }, path = `/run-units/${runUnitId}/retry`) => {
  let received: unknown;
  const wakes: string[] = [];
  const app = createOperatorRetryApp({ records: { retry_unit: async (input) => { received = input; return result; } }, now: () => "2026-08-29T00:00:00Z",
    send_run_wake: async (_run_id, key) => { wakes.push(key); } });
  return { response: app.request(path, { method: "PUT", headers }), received: () => received, wakes };
};

test("operator retry forwards the durable unit and idempotency identity, and wakes the run once created", async () => {
  const workOrder = { id: "00000000-0000-4000-8000-000000000002", run_unit_id: runUnitId, reason: "operator_retry", input_snapshot: [], input_fingerprint: "input", state: "available", workflow_id: "v2-work:retry", request_idempotency_key: "operator_retry:retry-1", created_at: "2026-08-29T00:00:00Z", completed_at: null } as const;
  const call = request({ kind: "created", work_order: workOrder as never, run_id: "00000000-0000-4000-8000-000000000003" as never, record_version: 2 as never });
  expect((await call.response).status).toBe(202);
  expect(call.received()).toEqual({ target: { kind: "run_unit", run_unit_id: runUnitId }, idempotency_key: "retry-1", actor: "operator" });
  expect(call.wakes).toEqual(["operator_retry:00000000-0000-4000-8000-000000000003:2"]);
});

test("operator retry addressed by stage instance and unit id forwards that identity for the repository to resolve", async () => {
  const workOrder = { id: "00000000-0000-4000-8000-000000000002", run_unit_id: runUnitId, reason: "operator_retry", input_snapshot: [], input_fingerprint: "input", state: "available", workflow_id: "v2-work:retry", request_idempotency_key: "operator_retry:retry-1", created_at: "2026-08-29T00:00:00Z", completed_at: null } as const;
  const call = request({ kind: "created", work_order: workOrder as never, run_id: "00000000-0000-4000-8000-000000000003" as never, record_version: 2 as never },
    { "Idempotency-Key": "retry-1" }, `/stage_instances/${stageInstanceId}/units/cohort-a/retry`);
  const response = await call.response;
  expect(response.status).toBe(202);
  expect((await response.json()).run_unit_id).toBe(runUnitId);
  expect(call.received()).toEqual({ target: { kind: "stage_unit", stage_instance_id: stageInstanceId, unit_id: "cohort-a" as UnitId }, idempotency_key: "retry-1", actor: "operator" });
  expect((await createOperatorRetryApp({ records: { retry_unit: async () => ({ kind: "unit_not_found", detail: "missing" }) }, now: () => "now" })
    .request("/stage_instances/not-a-uuid/units/cohort-a/retry", { method: "PUT", headers: { "Idempotency-Key": "retry" } })).status).toBe(400);
});

test("operator retry maps replay and missing work", async () => {
  const workOrder = { id: "00000000-0000-4000-8000-000000000002", run_unit_id: runUnitId, reason: "operator_retry", input_snapshot: [], input_fingerprint: "input", state: "available", workflow_id: "v2-work:retry", request_idempotency_key: "operator_retry:retry-1", created_at: "2026-08-29T00:00:00Z", completed_at: null } as const;
  const replay = request({ kind: "already_created", work_order: workOrder as never, run_id: "00000000-0000-4000-8000-000000000003" as never, record_version: 2 as never });
  expect((await replay.response).status).toBe(200);
  const missingWork = request({ kind: "no_missing_work", detail: "nothing missing" });
  expect((await missingWork.response).status).toBe(409);
  expect((await (await missingWork.response).json()).kind).toBe("no_missing_work");
});

test("operator retry distinguishes not found from malformed identity", async () => {
  expect((await request({ kind: "unit_not_found", detail: "missing" }).response).status).toBe(404);
  expect((await createOperatorRetryApp({ records: { retry_unit: async () => ({ kind: "unit_not_found", detail: "missing" }) }, now: () => "now" })
    .request("/run-units/not-a-uuid/retry", { method: "PUT", headers: { "Idempotency-Key": "retry" } })).status).toBe(400);
  expect((await request({ kind: "unit_not_found", detail: "missing" }, {}).response).status).toBe(400);
});
