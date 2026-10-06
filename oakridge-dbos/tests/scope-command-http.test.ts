import { expect, test } from "bun:test";
import { MAX_PUBLICATION_VALUE_BYTES } from "../src/http/publication";
import { harness, unit } from "./scope-command-fixture";

test("HTTP rejects malformed commands with 400", async () => {
  expect((await (await harness()).submit({})).status).toBe(400);
});
test("HTTP rejects undeclared commands with 422", async () => {
  const api = await harness();
  expect((await api.submit({ ...api.request, command_key: "missing" })).status).toBe(422);
});
test("HTTP reports a missing scope with 404", async () => {
  expect((await (await harness({ missing_scope: true })).submit()).status).toBe(404);
});
test("HTTP rejects stale scope versions with 409", async () => {
  const api = await harness();
  expect((await api.submit({ ...api.request, expected_scope_version: 3 })).status).toBe(409);
});
test("HTTP rejects stale target revisions with 409", async () => {
  const api = await harness();
  expect((await api.submit({ ...api.request, targets: [{ identity: "revision-1", version: 2 }] })).status).toBe(409);
});
test("publication refuses an oversized value before staging", async () => {
  const api = await harness();
  const response = await api.app.request("/api/runs/run-1/scopes/scope-1/publications", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ request_id: "oversized", expected_scope_version: 4,
      trigger: { id: "oversized", key: "publish", payload: unit }, output: { scope_id: "scope-1", output_key: "report",
        collection_key: "", body: { schema: "text", data: { kind: "string", value: "x".repeat(MAX_PUBLICATION_VALUE_BYTES) } },
        predecessor_id: null, expected_slot_version: null, execution_id: null } }) });
  expect({ status: response.status, kind: (await response.json()).kind }).toEqual({ status: 413, kind: "oversized_payload" });
});
test("a changed non-target witness between validation and commit retries with a fresh evaluation", async () => {
  const api = await harness({ change_witness_before_commit: true });
  expect({ status: (await api.submit()).status, evaluations: api.evaluationCount() }).toEqual({ status: 202, evaluations: 2 });
});
test("a command without targets retries after a witness change even when its outcome is a wait", async () => {
  const api = await harness({ wait_decision: true, change_witness_before_commit: true });
  const response = await api.submit({ ...api.request, command_key: "rework", payload: {}, targets: [] });
  expect({ status: response.status, evaluations: api.evaluationCount() }).toEqual({ status: 202, evaluations: 2 });
});
test("a changed target between validation and commit re-evaluates and then conflicts with 409", async () => {
  const api = await harness({ change_target_before_commit: true });
  expect({ status: (await api.submit()).status, evaluations: api.evaluationCount() }).toEqual({ status: 409, evaluations: 2 });
});
test("HTTP core transport failures return 503", async () => {
  expect((await (await harness({ transport_failure: true })).submit()).status).toBe(503);
});
test("HTTP database failures return 500 with a trace ID", async () => {
  const response = await (await harness({ database_failure: true })).submit();
  expect({ status: response.status, body: await response.json() }).toMatchObject({ status: 500, body: { error: "internal_fault", trace_id: expect.any(String) } });
});
test("unexpected core validation responses return 500", async () => {
  expect((await (await harness({ malformed_core: true })).submit()).status).toBe(500);
});
test("an accepted command commits the checked decision with one evaluation", async () => {
  const api = await harness();
  expect({ status: (await api.submit()).status, evaluations: api.evaluationCount() }).toEqual({ status: 202, evaluations: 1 });
});
test("identical command retry replays its receipt after terminal state without core IO", async () => {
  const api = await harness();
  const first = await (await api.submit()).json();
  api.terminate();
  const replay = await api.submit();
  expect({ status: replay.status, body: await replay.json(), evaluations: api.evaluationCount() }).toEqual({ status: 202, body: first, evaluations: 1 });
});
test("reusing a committed request ID with different targets conflicts", async () => {
  const api = await harness();
  await api.submit();
  expect((await api.submit({ ...api.request, targets: [{ identity: "revision-2", version: 4 }] })).status).toBe(409);
});
test("reusing a committed request ID with different payload conflicts", async () => {
  const api = await harness();
  await api.submit();
  expect((await api.submit({ ...api.request, payload: {} })).status).toBe(409);
});

test("command commit stores its validated payload instead of the snapshot placeholder", async () => {
  const api = await harness();
  await api.submit();
  expect(api.committedPayload()).toEqual(unit);
});

test("scope API exposes output bodies and observed non-output command targets", async () => {
  const api = await harness({ operator_workspace: true });
  const response = await api.app.request("/api/runs/run-1/scopes/scope-1");
  expect({ status: response.status, body: await response.json() }).toMatchObject({ status: 200, body: {
    outputs: [{ version: 3, current_revision: { id: "revision-1", version: 2,
      body: { schema: "unregistered_output", data: { kind: "string", value: "Output artifact body" } } } }],
    command_targets: { discuss: [{ identity: "exec-1", version: 6 }], change: [{ identity: "exec-1", version: 6 }] },
    cursor: { scope_version: 4 },
  } });
});

test("operator workspace history starts empty for its existing scope", async () => {
  const api = await harness({ operator_workspace: true });
  const response = await api.app.request("/api/runs/run-1/scopes/scope-1/history");
  expect({ status: response.status, body: await response.json() }).toEqual({
    status: 200, body: { scope_id: "scope-1", transitions: [], facts: [] },
  });
});
