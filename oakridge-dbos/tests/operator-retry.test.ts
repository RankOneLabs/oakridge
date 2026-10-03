import { expect, test } from "bun:test";

import { createOperatorRetryApp } from "../src/http/operator-retry";
import { selectCohortRetryability } from "../src/domain/cohort-retry";
import type { RetryCohortResult } from "../src/domain/run-record";
import type { AttemptId, CohortId, StageInstanceId, WorkflowRunId } from "../src/domain/primitives";

const cohortId = "00000000-0000-4000-8000-000000000001" as CohortId;
const runId = "00000000-0000-4000-8000-000000000003" as WorkflowRunId;
const attemptId = "00000000-0000-4000-8000-000000000002" as AttemptId;
const stageInstanceId = "00000000-0000-4000-8000-000000000004" as StageInstanceId;

const created: RetryCohortResult = { kind: "created", run_id: runId, cohort_id: cohortId, attempt_id: attemptId,
  attempt_number: 2, durable_version: 5 };

test("only a blocked operator retry is retryable; failed cohorts are terminal", () => {
  const lost = { status: "blocked" as const, blocked_reason: "retry" as const, next_actor: "operator" as const };
  expect(selectCohortRetryability(lost)).toEqual({ kind: "retryable" });
  expect(selectCohortRetryability({ ...lost, status: "failed" })).toEqual({ kind: "not_retryable", reason: "terminal" });
  expect(selectCohortRetryability({ ...lost, blocked_reason: "gate" })).toEqual({ kind: "not_retryable", reason: "gate_pending" });
});

const request = (result: RetryCohortResult, headers: Record<string, string> = { "Idempotency-Key": "retry-1" }, path = `/run-units/${cohortId}/retry`) => {
  let received: unknown;
  const app = createOperatorRetryApp({ retry_through_driver: async (target, idempotency_key) => {
    received = { target, idempotency_key }; return result;
  } });
  return { response: app.request(path, { method: "PUT", headers }), received: () => received };
};

test("operator retry forwards the durable cohort and idempotency identity", async () => {
  const call = request(created);
  expect((await call.response).status).toBe(202);
  expect(call.received()).toEqual({ target: { kind: "cohort", cohort_id: cohortId }, idempotency_key: "retry-1" });
});

test("operator retry addressed by stage instance and cohort key forwards that identity for the repository to resolve", async () => {
  const call = request(created, { "Idempotency-Key": "retry-1" }, `/stage_instances/${stageInstanceId}/units/cohort-a/retry`);
  const response = await call.response;
  expect(response.status).toBe(202);
  expect((await response.json()).attempt_id).toBe(attemptId);
  expect(call.received()).toEqual({ target: { kind: "stage_cohort", stage_instance_id: stageInstanceId, cohort_key: "cohort-a" }, idempotency_key: "retry-1" });
  expect((await createOperatorRetryApp({ retry_through_driver: async () => ({ kind: "cohort_not_found", detail: "missing" }) })
    .request("/stage_instances/not-a-uuid/units/cohort-a/retry", { method: "PUT", headers: { "Idempotency-Key": "retry" } })).status).toBe(400);
});

test("operator retry maps replay and a cohort that has nothing to retry", async () => {
  const replay = request({ ...created, kind: "already_created" });
  expect((await replay.response).status).toBe(200);
  const terminal = request({ kind: "not_retryable", reason: "terminal" });
  expect((await terminal.response).status).toBe(409);
  expect(await (await terminal.response).json()).toEqual({ kind: "not_retryable", reason: "terminal" });
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
});

test("operator retry distinguishes not found from malformed identity", async () => {
  expect((await request({ kind: "cohort_not_found", detail: "missing" }).response).status).toBe(404);
  expect((await createOperatorRetryApp({ retry_through_driver: async () => ({ kind: "cohort_not_found", detail: "missing" }) })
    .request("/run-units/not-a-uuid/retry", { method: "PUT", headers: { "Idempotency-Key": "retry" } })).status).toBe(400);
  expect((await request({ kind: "cohort_not_found", detail: "missing" }, {}).response).status).toBe(400);
});

test("a typed worker request reaches cohort ingress with the path identity and expected version", async () => {
  let received: import("../src/domain/dev-flow-v15").OperatorRequestEnvelope | null = null;
  const app = createOperatorRetryApp({ retry_through_driver: async () => created,
    submit_request: async (request) => { received = request; return { ok: true, value: { commits: 1, reason: "builder response pending" } }; } });
  const body = { id: "00000000-0000-4000-8000-000000000090", expected_version: 7, request: { kind: "retry_build" } };
  const response = await app.request(`/cohorts/${cohortId}/requests`, { method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json" } });
  expect<unknown>({ status: response.status, received }).toEqual({ status: 202, received: { ...body, cohort_id: cohortId } });
});

test("an unknown request field is refused before cohort ingress can mutate", async () => {
  let calls = 0;
  const app = createOperatorRetryApp({ retry_through_driver: async () => created,
    submit_request: async () => { calls++; return { ok: true, value: { commits: 1, reason: "wait" } }; } });
  const response = await app.request(`/cohorts/${cohortId}/requests`, { method: "POST", body: JSON.stringify({
    id: "00000000-0000-4000-8000-000000000090", expected_version: 7, request: { kind: "retry_build", worker: "assessment" },
  }), headers: { "content-type": "application/json" } });
  expect({ status: response.status, calls }).toEqual({ status: 422, calls: 0 });
});
