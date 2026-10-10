import { expect, test } from "bun:test";
import { MAX_PUBLICATION_VALUE_BYTES } from "../src/http/publication";
import { harness, unit } from "./scope-command-fixture";
import type { CheckedValue, DefinitionBundle } from "../src/core-client/generated-contracts";

async function editHarness(is_invalid_body = false) {
  const api = await harness();
  const previous: CheckedValue = { schema: "unregistered_output", data: { kind: "string", value: "Output artifact body" } };
  const edited: CheckedValue = { schema: "unregistered_output", data: { kind: "string", value: "Edited body" } };
  const query = api.deps.db.query.bind(api.deps.db);
  let written: { readonly predecessor_id: string; readonly body: CheckedValue } | null = null;
  Object.assign(api.deps.db, { query: async (sql: string, parameters: readonly unknown[]) => {
    if (sql.startsWith("SELECT s.id,s.version,s.current_revision_id,r.body"))
      return [{ id: "slot-1", version: 3, current_revision_id: "revision-1", body: previous }];
    if (sql.startsWith("INSERT INTO authority.artifact_revision"))
      written = { predecessor_id: String(parameters[6]), body: JSON.parse(String(parameters[5])) as CheckedValue };
    const rows = await query(sql, parameters);
    if (!sql.startsWith("SELECT b.source")) return rows;
    return rows.map((row) => {
      const pinned = row as { readonly source: DefinitionBundle };
      const source: DefinitionBundle = { ...pinned.source, scopes: pinned.source.scopes.map((scope) => ({ ...scope,
        commands: [...scope.commands, { key: "edit_specimen", label: "Edit specimen", consequence: "publish an edit",
          payload_schema: "unit", available_in: ["inspection"], required: false, targets: [], field_presentation: [] }],
        outputs: scope.outputs.map((output) => ({ ...output, schema: "unregistered_output", edit_trigger: "edit_specimen" })) })) };
      return { ...row, source };
    });
  } });
  Object.assign(api.deps.core, { request: async (operation: string, input: unknown) => {
    if (operation === "validate_value") return is_invalid_body
      ? { ok: false, error: { kind: "domain", detail: { kind: "invalid_payload", operation, entity_id: "specimen", path: "", expected: "text", actual: "invalid", detail: "invalid edit" } } }
      : { ok: true, value: { kind: "validated", value: (input as { readonly value: CheckedValue }).value } };
    if (operation === "validate_payload") return { ok: true, value: { kind: "validated", value: unit } };
    return { ok: true, value: { kind: "evaluated", value: { kind: "apply", targets: [], mutations: [], invocations: [], outcome: null,
      explanation: { bundle_digest: "pinned", node_id: "edit", owner: "scope-1", read_set: [], trace: [], trigger_id: "edit-1" } } } };
  } });
  const request = { ...api.request, command_key: "edit_specimen", request_id: "edit-1", targets: [],
    payload: { output_key: "specimen", collection_key: "", reviewed_revision_id: "revision-1", prev_value: previous, body: edited } };
  return { ...api, request, writtenRevision: () => written };
}

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
  const response = await api.submit({ ...api.request, expected_scope_version: 3 });
  expect({ status: response.status, body: await response.json(), writes: api.committedPayload() })
    .toMatchObject({ status: 409, body: { error: "scope version changed", code: "conflict" }, writes: null });
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
  expect({ status: response.status, body: await response.json() }).toMatchObject({ status: 500, body: { code: "internal_fault", trace_id: expect.any(String) } });
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
  const response = await api.submit({ ...api.request, payload: {} });
  expect({ status: response.status, body: await response.json() }).toMatchObject({ status: 409,
    body: { code: "conflict", error: "request ID reused with different command content" } });
});

test("an edit with a stale previous value conflicts without writing a revision", async () => {
  const api = await editHarness();
  const response = await api.submit({ ...api.request, payload: { ...api.request.payload,
    prev_value: unit } });
  expect({ status: response.status, body: await response.json(), written: api.writtenRevision() })
    .toMatchObject({ status: 409, body: { code: "conflict", error: "output specimen changed since review" }, written: null });
});

test("an edited body failing its declared schema names the output and writes nothing", async () => {
  const api = await editHarness(true);
  const response = await api.submit(api.request);
  expect({ status: response.status, body: await response.json(), written: api.writtenRevision() })
    .toMatchObject({ status: 422, body: { code: "invalid_payload", error: "output specimen does not match declared schema" }, written: null });
});

test("an accepted edit publishes the reviewed revision as predecessor", async () => {
  const api = await editHarness();
  const response = await api.submit(api.request);
  expect({ status: response.status, written: api.writtenRevision() }).toMatchObject({ status: 202,
    written: { predecessor_id: "revision-1", body: api.request.payload.body } });
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
