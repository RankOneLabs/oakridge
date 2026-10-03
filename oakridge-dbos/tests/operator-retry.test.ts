import { expect, test } from "bun:test";
import { createOperatorRetryApp } from "../src/http/operator-retry";
import type { CohortId } from "../src/domain/primitives";
const cohortId = "00000000-0000-4000-8000-000000000001" as CohortId;

test("a typed worker request reaches cohort ingress with the path identity and expected version", async () => {
  let received: import("../src/domain/dev-flow-v15").V15OperatorRequestEnvelope | null = null;
  const app = createOperatorRetryApp({ submit_request: async (request) => { received = request; return { ok: true, value: { commits: 1, reason: "builder response pending" } }; } });
  const body = { id: "00000000-0000-4000-8000-000000000090", expected_version: 7, request: { kind: "retry_build" } };
  const response = await app.request(`/cohorts/${cohortId}/requests`, { method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json" } });
  expect<unknown>({ status: response.status, received }).toEqual({ status: 202, received: { ...body, cohort_id: cohortId } });
});

test("an unknown request field is refused before cohort ingress can mutate", async () => {
  let calls = 0;
  const app = createOperatorRetryApp({ submit_request: async () => { calls++; return { ok: true, value: { commits: 1, reason: "wait" } }; } });
  const response = await app.request(`/cohorts/${cohortId}/requests`, { method: "POST", body: JSON.stringify({
    id: "00000000-0000-4000-8000-000000000090", expected_version: 7, request: { kind: "retry_build", worker: "assessment" },
  }), headers: { "content-type": "application/json" } });
  expect({ status: response.status, calls }).toEqual({ status: 422, calls: 0 });
});

test("all non-implementation worker requests use the same versioned ingress", async () => {
  const seen: string[] = [];
  const app = createOperatorRetryApp({ submit_request: async (envelope) => {
    seen.push(envelope.request.kind); return { ok: true, value: { commits: 1, reason: "wait" } };
  } });
  for (const kind of ["retry_provision", "retry_analysis", "retry_plan", "retry_briefs", "retry_final_integration"]) {
    const response = await app.request(`/cohorts/${cohortId}/requests`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "00000000-0000-4000-8000-000000000090", expected_version: 7, request: { kind } }) });
    expect(response.status).toBe(202);
  }
  expect(seen).toEqual(["retry_provision", "retry_analysis", "retry_plan", "retry_briefs", "retry_final_integration"]);
});

test("retired retry routes cannot launch an attempt", async () => {
  let calls = 0;
  const app = createOperatorRetryApp({ submit_request: async () => { calls++; return { ok: true, value: { commits: 0, reason: "wait" } }; } });
  expect((await app.request(`/run-units/${cohortId}/retry`, { method: "PUT" })).status).toBe(404);
  expect(calls).toBe(0);
});
