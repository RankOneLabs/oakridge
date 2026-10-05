import { expect, test } from "bun:test";
import { Hono } from "hono";
import { resolve } from "node:path";
import { Pool } from "pg";
import { CoreClient } from "../src/core-client/client";
import type { CheckedValue, DefinitionBundle } from "../src/core-client/generated-contracts";
import { installDefinitionApi } from "../src/http/app";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { createMutationService, type MutationService, type StartedRun } from "../src/storage/mutation-service";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import type { PublicationRequest } from "../src/http/publication";
import type { ScopeDiagnostics } from "../src/http/diagnostics";
import type { ScopeView } from "../src/projections/scope-view";
import type { ScopeCommandRequest } from "../src/http/scope-commands";

interface TestAuthority { readonly db: PgPostgresExecutor; readonly core: CoreClient; readonly mutations: MutationService; readonly bundle: DefinitionBundle; readonly run: StartedRun; readonly database_url: string; readonly request: ScopeCommandRequest; closeReaders(): Promise<void> }
const binary = resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli");
async function withAuthority(operation: (authority: TestAuthority) => Promise<void>): Promise<void> {
  const admin_url = process.env.OAKRIDGE_TEST_DATABASE_URL;
  if (!admin_url) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required for scope command integration tests");
  const name = `commands_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: admin_url });
  const url = new URL(admin_url); url.pathname = `/${name}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const db = PgPostgresExecutor.connect(url.href);
  const started = CoreClient.start({ binary, deadlineMs: 10_000 });
  if (!started.ok) throw new Error(started.error.detail.detail);
  const core = started.value;
  let readers_closed = false;
  async function closeReaders(): Promise<void> {
    if (readers_closed) return;
    core.close(); await db.close(); readers_closed = true;
  }
  try {
    await migrateEmptyDatabase(db);
    const bundle: DefinitionBundle = await Bun.file(resolve(import.meta.dir, "../../workflow-core/fixtures/bundles/exact-review-target.json")).json();
    const mutations = createMutationService(db, core);
    const created = await mutations.startRun({ bundle, available_operations: bundle.operations, input: {} });
    if (!created.ok) throw new Error(created.error.detail);
    const run = created.value;
    const unit: CheckedValue = { schema: "unit", data: { kind: "record", fields: [], dictionary: [] } };
    const state: CheckedValue = { schema: "phase", data: { kind: "variant", variant: "inspection", value: unit } };
    const revision: CheckedValue = { schema: "revision", data: { kind: "reference", brand: "artifact_revision", id: "revision-1" } };
    await db.query("UPDATE authority.scope_instance SET local_state=$1 WHERE id=$2", [JSON.stringify(state), run.root_scope_id]);
    await db.query("INSERT INTO authority.artifact_revision (id,scope_id,output_key,body) VALUES ('revision-1',$1,'specimen',$2)", [run.root_scope_id, JSON.stringify(revision)]);
    await db.query("INSERT INTO authority.output_slot (id,scope_id,output_key,current_revision_id) VALUES ('slot-1',$1,'specimen','revision-1')", [run.root_scope_id]);
    const request: ScopeCommandRequest = { command_key: "certify", payload: { specimen: { brand: "artifact_revision", id: "revision-1" } }, request_id: "request-1", scope_id: run.root_scope_id,
      expected_scope_version: 0, targets: [{ identity: "revision-1", version: 0 }] };
    await operation({ db, core, mutations, bundle, run, database_url: url.href, request, closeReaders });
  } finally {
    await closeReaders();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end();
  }
}
function api(authority: TestAuthority, mutations = authority.mutations): Hono {
  const app = new Hono();
  installDefinitionApi(app, { db: authority.db, core: authority.core, mutations, sweep: async () => {} });
  return app;
}
async function submit(app: Hono, authority: TestAuthority, request = authority.request): Promise<Response> {
  return app.request(`/api/runs/${authority.run.run_id}/scopes/${authority.run.root_scope_id}/commands`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
}

test("real command commit and terminal retry share one receipt and transition", async () => {
  await withAuthority(async (authority) => {
    const app = api(authority);
    const first = await submit(app, authority);
    expect({ status: first.status, body: await first.clone().json() }).toMatchObject({ status: 202, body: { kind: "accepted_pending" } });
    const replay = await submit(app, authority);
    expect({ status: replay.status, body: await replay.json() }).toEqual({ status: 202, body: await first.json() });
    expect((await submit(app, authority, { ...authority.request, targets: [{ identity: "revision-2", version: 1 }] })).status).toBe(409);
    const rows = await authority.db.query<{ is_terminal: boolean; transitions: string }>("SELECT is_terminal,(SELECT count(*)::text FROM authority.transition) AS transitions FROM authority.scope_instance WHERE id=$1", [authority.run.root_scope_id]);
    expect(rows).toEqual([{ is_terminal: true, transitions: "1" }]);
  });
});

test("real commit rejects a target changed after API validation without changing owner version", async () => {
  await withAuthority(async (authority) => {
    const mutations: MutationService = { ...authority.mutations, async decide(input) {
      await authority.db.query("UPDATE authority.output_slot SET version=version+1 WHERE id='slot-1'", []);
      return authority.mutations.decide(input);
    } };
    expect((await submit(api(authority, mutations), authority)).status).toBe(409);
    const rows = await authority.db.query<{ count: string }>("SELECT count(*)::text FROM authority.transition", []);
    expect(rows).toEqual([{ count: "0" }]);
  });
});

test("pinned definitions and scope projections survive a newer bundle and fresh clients", async () => {
  await withAuthority(async (authority) => {
    const newer: DefinitionBundle = { ...authority.bundle, version: 2, scopes: authority.bundle.scopes.map((scope) => ({ ...scope,
      presentation: { ...scope.presentation, label: "New deployment" }, commands: scope.commands.map((command) => ({ ...command, label: "New command label" })) })) };
    const created = await authority.mutations.startRun({ bundle: newer, available_operations: newer.operations, input: {} });
    if (!created.ok) throw new Error(created.error.detail);
    const before = await (await api(authority).request(`/api/runs/${authority.run.run_id}/scopes/${authority.run.root_scope_id}`)).json();
    await authority.closeReaders();
    const db = PgPostgresExecutor.connect(authority.database_url);
    const started = CoreClient.start({ binary, deadlineMs: 10_000 });
    if (!started.ok) throw new Error(started.error.detail.detail);
    try {
      const fresh = api({ ...authority, db, core: started.value, mutations: createMutationService(db, started.value) });
      const pinned = await (await fresh.request(`/api/runs/${authority.run.run_id}/definition`)).json();
      expect(pinned.source).toEqual(authority.bundle);
      expect(await (await fresh.request(`/api/runs/${authority.run.run_id}/scopes/${authority.run.root_scope_id}`)).json()).toEqual(before);
      expect((await submit(fresh, authority)).status).toBe(202);
    } finally { started.value.close(); await db.close(); }
  });
});

test("publication retry after terminal commit replays one revision and receipt", async () => {
  await withAuthority(async (authority) => {
    await authority.db.query("INSERT INTO authority.execution (id,scope_id,worker_key,generation,status) VALUES ('execution-1',$1,'potter',1,'terminal')", [authority.run.root_scope_id]);
    await authority.db.query("INSERT INTO authority.execution_selection (id,scope_id,worker_key,execution_id,generation) VALUES ('selection-1',$1,'potter','execution-1',1)", [authority.run.root_scope_id]);
    const unit: CheckedValue = { schema: "unit", data: { kind: "record", fields: [], dictionary: [] } };
    const publication: PublicationRequest = { request_id: "publication-1", expected_scope_version: 0,
      trigger: { id: "publication-1", key: "quench", payload: unit },
      output: { scope_id: authority.run.root_scope_id, output_key: "specimen", collection_key: "", execution_id: "execution-1",
        predecessor_id: "revision-1", expected_slot_version: 0,
        body: { schema: "revision", data: { kind: "reference", brand: "artifact_revision", id: "revision-2" } } } };
    const app = api(authority);
    const path = `/api/runs/${authority.run.run_id}/scopes/${authority.run.root_scope_id}/publications`;
    const publish = (body: PublicationRequest) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const first = await publish(publication);
    expect({ status: first.status, body: await first.clone().json() }).toMatchObject({ status: 202, body: { kind: "accepted_pending" } });
    const replay = await publish(publication);
    expect({ status: replay.status, body: await replay.json() }).toEqual({ status: 202, body: await first.json() });
    expect((await publish({ ...publication, output: { ...publication.output, predecessor_id: null } })).status).toBe(409);
    const rows = await authority.db.query<{ is_terminal: boolean; revisions: string; transitions: string }>("SELECT is_terminal,(SELECT count(*)::text FROM authority.artifact_revision) AS revisions,(SELECT count(*)::text FROM authority.transition) AS transitions FROM authority.scope_instance WHERE id=$1", [authority.run.root_scope_id]);
    expect(rows).toEqual([{ is_terminal: true, revisions: "2", transitions: "1" }]);
  });
});

test("scope and diagnostics APIs return numeric PostgreSQL versions and generations", async () => {
  await withAuthority(async (authority) => {
    await authority.db.query("INSERT INTO authority.execution (id,scope_id,worker_key,generation,status,version) VALUES ('execution-1',$1,'potter',7,'pending',9)", [authority.run.root_scope_id]);
    await authority.db.query("INSERT INTO authority.resource_binding (id,scope_id,resource_key,version) VALUES ('resource-1',$1,'source',11)", [authority.run.root_scope_id]);
    await authority.db.query("UPDATE authority.output_slot SET version=12 WHERE id='slot-1'", []);
    await authority.db.query("INSERT INTO authority.effect_intent (id,scope_id,effect_key,payload,version) VALUES ('effect-1',$1,'start','{}',13)", [authority.run.root_scope_id]);
    const app = api(authority);
    const path = `/api/runs/${authority.run.run_id}/scopes/${authority.run.root_scope_id}`;
    const scope: ScopeView = await (await app.request(path)).json();
    const diagnostics: ScopeDiagnostics = await (await app.request(`${path}/diagnostics`)).json();
    expect({ scope: { version: scope.cursor.scope_version, generation: scope.executions[0]?.generation, execution: scope.executions[0]?.version, output: scope.outputs[0]?.version, resource: scope.resources[0]?.version },
      diagnostics: { version: diagnostics.scope_version, generation: diagnostics.executions[0]?.generation, execution: diagnostics.executions[0]?.version, resource: diagnostics.resources[0]?.version, effect: diagnostics.effects[0]?.version } })
      .toEqual({ scope: { version: 0, generation: 7, execution: 9, output: 12, resource: 11 }, diagnostics: { version: 0, generation: 7, execution: 9, resource: 11, effect: 13 } });
  });
});

test("diagnostics cursor changes on effect updates without a scope transition", async () => {
  await withAuthority(async (authority) => {
    await authority.db.query("INSERT INTO authority.effect_intent (id,scope_id,effect_key,payload) VALUES ('effect-1',$1,'start','{}')", [authority.run.root_scope_id]);
    const app = api(authority);
    const path = `/api/runs/${authority.run.run_id}/scopes/${authority.run.root_scope_id}/diagnostics`;
    const before: ScopeDiagnostics = await (await app.request(path)).json();
    await authority.db.query("UPDATE authority.effect_intent SET status='in_flight',version=version+1 WHERE id='effect-1'", []);
    const after: ScopeDiagnostics = await (await app.request(path)).json();
    expect({ before: before.cursor, after: after.cursor }).toEqual({
      before: { scope_version: 0, executions: [], resources: [], effects: [{ id: "effect-1", version: 0 }] },
      after: { scope_version: 0, executions: [], resources: [], effects: [{ id: "effect-1", version: 1 }] },
    });
  });
});
