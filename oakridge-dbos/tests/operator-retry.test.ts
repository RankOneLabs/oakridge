import { expect, test } from "bun:test";

import { createOperatorRetryApp } from "../src/http/operator-retry";
import type { RetryCohortResult } from "../src/domain/run-record";
import type { AttemptId, CohortId, StageInstanceId, WorkflowRunId } from "../src/domain/primitives";

const cohortId = "00000000-0000-4000-8000-000000000001" as CohortId;
const runId = "00000000-0000-4000-8000-000000000003" as WorkflowRunId;
const attemptId = "00000000-0000-4000-8000-000000000002" as AttemptId;
const stageInstanceId = "00000000-0000-4000-8000-000000000004" as StageInstanceId;

const created: RetryCohortResult = { kind: "created", run_id: runId, cohort_id: cohortId, attempt_id: attemptId,
  attempt_number: 2, durable_version: 5 };

const request = (result: RetryCohortResult, headers: Record<string, string> = { "Idempotency-Key": "retry-1" }, path = `/run-units/${cohortId}/retry`) => {
  let received: unknown;
  const wakes: string[] = [];
  const app = createOperatorRetryApp({ records: { retry_cohort: async (input) => { received = input; return result; } }, now: () => "2026-08-29T00:00:00Z",
    send_cohort_wake: async (_cohort_id, key) => { wakes.push(key); } });
  return { response: app.request(path, { method: "PUT", headers }), received: () => received, wakes };
};

test("operator retry forwards the durable cohort and idempotency identity, and wakes the cohort once created", async () => {
  const call = request(created);
  expect((await call.response).status).toBe(202);
  expect(call.received()).toEqual({ target: { kind: "cohort", cohort_id: cohortId }, idempotency_key: "retry-1", actor: "operator" });
  expect(call.wakes).toEqual([`operator_retry:${cohortId}:2`]);
});

test("operator retry addressed by stage instance and cohort key forwards that identity for the repository to resolve", async () => {
  const call = request(created, { "Idempotency-Key": "retry-1" }, `/stage_instances/${stageInstanceId}/units/cohort-a/retry`);
  const response = await call.response;
  expect(response.status).toBe(202);
  expect((await response.json()).attempt_id).toBe(attemptId);
  expect(call.received()).toEqual({ target: { kind: "stage_cohort", stage_instance_id: stageInstanceId, cohort_key: "cohort-a" }, idempotency_key: "retry-1", actor: "operator" });
  expect((await createOperatorRetryApp({ records: { retry_cohort: async () => ({ kind: "cohort_not_found", detail: "missing" }) }, now: () => "now" })
    .request("/stage_instances/not-a-uuid/units/cohort-a/retry", { method: "PUT", headers: { "Idempotency-Key": "retry" } })).status).toBe(400);
});

test("operator retry maps replay and a cohort that has nothing to retry", async () => {
  const replay = request({ ...created, kind: "already_created" });
  expect((await replay.response).status).toBe(200);
  const notActive = request({ kind: "not_active", detail: "cohort is complete" });
  expect((await notActive.response).status).toBe(409);
  expect((await (await notActive.response).json()).kind).toBe("not_active");
});

/**
 * An `Idempotency-Key` that already produced an attempt must not open a second
 * one, and a key reused for *different* work must be refused rather than
 * silently retried — which is why the key has storage of its own
 * (`attempt.idempotency_key`, 0017) and not only the transition ledger's
 * per-version uniqueness.
 */
test("a reused idempotency key is a conflict, not a fresh retry", async () => {
  const conflict = request({ kind: "idempotency_conflict", detail: "already used for attempt 2" });
  const response = await conflict.response;
  expect(response.status).toBe(409);
  expect((await response.json()).kind).toBe("idempotency_conflict");
  expect(conflict.wakes).toEqual([]);
});

test("operator retry distinguishes not found from malformed identity", async () => {
  expect((await request({ kind: "cohort_not_found", detail: "missing" }).response).status).toBe(404);
  expect((await createOperatorRetryApp({ records: { retry_cohort: async () => ({ kind: "cohort_not_found", detail: "missing" }) }, now: () => "now" })
    .request("/run-units/not-a-uuid/retry", { method: "PUT", headers: { "Idempotency-Key": "retry" } })).status).toBe(400);
  expect((await request({ kind: "cohort_not_found", detail: "missing" }, {}).response).status).toBe(400);
});
