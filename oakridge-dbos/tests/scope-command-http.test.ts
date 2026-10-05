import { expect, test } from "bun:test";
import { Hono } from "hono";
import { resolve } from "node:path";
import type { CoreClient } from "../src/core-client/client";
import type { CheckedValue, DefinitionBundle, DecisionOutcome, Output } from "../src/core-client/generated-contracts";
import { transportFailure, type CoreResult } from "../src/core-client/transport-errors";
import { installDefinitionApi } from "../src/http/app";
import { createMutationService } from "../src/storage/mutation-service";
import type { IngressReceiptRecord, RunId, ScopeId, ScopeInstanceRecord } from "../src/storage/schema-records";
import type { SqlExecutor, TransactionalSqlExecutor } from "../src/storage/sql-executor";
import type { ScopeCommandRequest } from "../src/http/scope-commands";

const run_id = "run-1" as RunId;
const scope_id = "scope-1" as ScopeId;
const unit: CheckedValue = { schema: "unit", data: { kind: "record", fields: [], dictionary: [] } };
const revision: CheckedValue = { schema: "revision", data: { kind: "reference", brand: "artifact_revision", id: "revision-1" } };
interface HarnessOptions { readonly transport_failure?: boolean; readonly malformed_core?: boolean; readonly missing_scope?: boolean; readonly database_failure?: boolean; readonly change_target_before_commit?: boolean }

async function harness(options: HarnessOptions = {}) {
  const bundle: DefinitionBundle = await Bun.file(resolve(import.meta.dir, "../../workflow-core/fixtures/bundles/exact-review-target.json")).json();
  let owner: ScopeInstanceRecord = { id: scope_id, version: 4, run_id, parent_id: null, scope_key: bundle.root, child_key: null,
    input: unit, local_state: { schema: "phase", data: { kind: "variant", variant: "inspection", value: unit } }, outcome: null, is_terminal: false };
  let slot_version = 3;
  let receipt: IngressReceiptRecord | null = null;
  let evaluate_count = 0;
  let committed_payload: CheckedValue | null = null;
  const db: TransactionalSqlExecutor = {
    async query<Row extends object>(sql: string, parameters: readonly unknown[]): Promise<readonly Row[]> {
      if (options.database_failure) throw new Error("database unavailable");
      let rows: readonly object[] = [];
      if (sql.startsWith("SELECT * FROM authority.ingress_receipt")) rows = receipt ? [receipt] : [];
      else if (sql === "SELECT * FROM authority.scope_instance WHERE id=$1") rows = options.missing_scope ? [] : [owner];
      else if (sql.startsWith("SELECT b.source")) rows = [{ source: bundle, checked_program: { scopes: [] } }];
      else if (sql.startsWith("SELECT id, version FROM authority.scope_instance")) rows = [{ id: scope_id, version: owner.version }];
      else if (sql.startsWith("SELECT e.id, e.version FROM authority.output_slot")) rows = [{ id: "slot-1", version: slot_version }];
      else if (sql.startsWith("SELECT s.*, r.body")) rows = [{ id: "slot-1", output_key: "specimen", body: revision, version: slot_version }];
      else if (sql.startsWith("SELECT id,current_revision_id,version")) rows = [{ id: "slot-1", current_revision_id: "revision-1", version: slot_version }];
      else if (sql.startsWith("UPDATE authority.scope_instance SET version")) owner = { ...owner, version: owner.version + 1 };
      else if (sql === "SELECT version FROM authority.scope_instance WHERE id=$1") rows = [{ version: owner.version }];
      else if (sql.startsWith("INSERT INTO authority.fact")) committed_payload = JSON.parse(String(parameters[3]));
      else if (sql.startsWith("INSERT INTO authority.ingress_receipt")) receipt = { id: String(parameters[0]), version: 0, run_id, scope_id,
        ingress_id: String(parameters[3]), request_digest: String(parameters[4]), result: JSON.parse(String(parameters[5])) };
      return rows as readonly Row[];
    },
    async transaction<Value>(operation: (tx: SqlExecutor) => Promise<Value>): Promise<Value> {
      // Change a dependency after HTTP target validation but before commit read-set validation.
      if (options.change_target_before_commit && evaluate_count > 0) slot_version++;
      return operation(this);
    },
  };
  const decision: DecisionOutcome = { kind: "apply", targets: [revision], mutations: [], invocations: [], outcome: null,
    explanation: { bundle_digest: "pinned", node_id: "finish_inspection", owner: scope_id, read_set: [], trace: [], trigger_id: "request-1" } };
  const core = {
    async request(operation: string): Promise<CoreResult<Output>> {
      if (options.transport_failure) return transportFailure("unresponsive_child", "deadline exceeded");
      if (options.malformed_core) return { ok: true, value: { kind: "evaluated", value: decision } };
      if (operation === "validate_payload") return { ok: true, value: { kind: "validated", value: unit } };
      evaluate_count++;
      return { ok: true, value: { kind: "evaluated", value: decision } };
    },
  } as unknown as CoreClient;
  const app = new Hono();
  installDefinitionApi(app, { db, core, mutations: createMutationService(db, core), sweep: async () => {} });
  const request: ScopeCommandRequest = { command_key: "certify", payload: { specimen: "revision-1" }, request_id: "request-1", scope_id,
    expected_scope_version: 4, targets: [{ identity: "revision-1", version: 3 }] };
  return {
    request,
    submit: (body: unknown = request) => app.request(`/api/runs/${run_id}/scopes/${scope_id}/commands`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    terminate: () => { owner = { ...owner, is_terminal: true, version: owner.version + 1 }; },
    evaluationCount: () => evaluate_count,
    committedPayload: () => committed_payload,
  };
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
  expect((await api.submit({ ...api.request, expected_scope_version: 3 })).status).toBe(409);
});
test("HTTP rejects stale target revisions with 409", async () => {
  const api = await harness();
  expect((await api.submit({ ...api.request, targets: [{ identity: "revision-1", version: 2 }] })).status).toBe(409);
});
test("a changed dependency between validation and commit returns 409", async () => {
  expect((await (await harness({ change_target_before_commit: true })).submit()).status).toBe(409);
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
