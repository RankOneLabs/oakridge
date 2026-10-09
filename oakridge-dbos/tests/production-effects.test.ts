import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { createProductionComposition } from "../src/runtime/compose";
import { GithubPullRequestReader } from "../src/runtime/github-pull-requests";
import { readSnapshot } from "../src/storage/snapshot-reader";
import type { CheckedValue } from "../src/core-client/generated-contracts";
import type { DefinitionBundle } from "../src/core-client/generated-contracts";
import type { EffectPayload } from "../src/effects/intents";
import type { StableInvocation } from "../src/effects/provider";
import { unit, withDatabase, waitUntil, operationBundle, sessionBundle, begin } from "./effect-fixture";
import type { StartedRun } from "../src/storage/mutation-service";
import { activeRoutes } from "../src/http/routes";
import { Hono } from "hono";
import { Pool } from "pg";
import { mountOakridgeProxyRoutes } from "../../kbbl/core/server/handlers/oakridge-proxy";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { PgPostgresExecutor, type TransactionalSqlExecutor } from "../src/storage/sql-executor";
import { readIntent } from "../src/effects/intents";
import { readInbox } from "../src/storage/projection-reader";
import { bundleContentHash } from "../src/core-client/bundle-content-hash";
import { installDefinitionApi } from "../src/http/app";
import type { CoreClient } from "../src/core-client/client";
import type { MutationService } from "../src/storage/mutation-service";
import { redactingView } from "../src/projections/serialization-view";
import { sealEffectPayload, unsealEffectPayload, verifyEffectEncryption } from "../src/storage/effect-secret";
import { developmentBundle, brief, repository, build_body } from "./development-runtime-fixture";

process.env.OAKRIDGE_EFFECT_ENCRYPTION_KEY ??= Buffer.alloc(32, 17).toString("base64url");

test("the outward serialization view removes publication credentials without changing replay bytes", () => {
  const prompt = "Authorization: Bearer very-secret-token";
  const source = { invocation: { bytes: prompt }, publication_secret_hash: "secret-hash" };
  expect(JSON.stringify(redactingView(source))).not.toContain("very-secret-token");
  expect(JSON.stringify(redactingView(source))).not.toContain("secret-hash");
  expect(source.invocation.bytes).toBe(prompt);
});

test("effect bytes are encrypted at rest and a missing or wrong key fails verification", async () => {
  const payload = { action: "start", handle: null, invocation: { id: "id", execution_id: "execution", selection: {},
    bytes: "Authorization: Bearer secret" } } as unknown as EffectPayload;
  const sealed = sealEffectPayload(payload);
  expect(JSON.stringify(sealed)).not.toContain("Bearer secret");
  expect(unsealEffectPayload(sealed).invocation.bytes).toBe(payload.invocation.bytes);
  const original = process.env.OAKRIDGE_EFFECT_ENCRYPTION_KEY;
  const db = { query: async () => [{ payload: sealed }] } as unknown as TransactionalSqlExecutor;
  try {
    delete process.env.OAKRIDGE_EFFECT_ENCRYPTION_KEY;
    await expect(verifyEffectEncryption(db)).rejects.toThrow("OAKRIDGE_EFFECT_ENCRYPTION_KEY");
    process.env.OAKRIDGE_EFFECT_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString("base64url");
    await expect(verifyEffectEncryption(db)).rejects.toThrow("encryption key is wrong");
  } finally {
    if (original) process.env.OAKRIDGE_EFFECT_ENCRYPTION_KEY = original;
  }
});

test("baseline inspection and application share an advisory-locked transaction", async () => {
  const statements: string[] = [];
  const tx = { query: async <Row extends object>(sql: string): Promise<readonly Row[]> => {
    statements.push(sql);
    if (sql.includes("server_version_num")) return [{ server_version_num: "150000" }] as unknown as readonly Row[];
    if (sql.includes("to_regclass")) return [{ name: "authority.schema_baseline" }] as unknown as readonly Row[];
    if (sql.includes("SELECT digest FROM authority.schema_baseline")) return [{ digest: "mismatch" }] as unknown as readonly Row[];
    return [];
  } };
  const db: TransactionalSqlExecutor = { query: tx.query,
    transaction: async (operation) => operation(tx) };
  await expect(migrateEmptyDatabase(db)).rejects.toThrow("digest mismatch");
  expect(statements.findIndex((sql) => sql.includes("pg_advisory_xact_lock"))).toBeGreaterThanOrEqual(0);
  expect(statements.findIndex((sql) => sql.includes("pg_advisory_xact_lock"))).toBeLessThan(statements.findIndex((sql) => sql.includes("SELECT digest FROM authority.schema_baseline")));
});

test("two processes can apply the empty authority baseline concurrently exactly once", async () => {
  const admin_url = process.env.OAKRIDGE_TEST_DATABASE_URL;
  if (!admin_url) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required");
  const admin = new Pool({ connectionString: admin_url });
  const name = `migration_${crypto.randomUUID().replaceAll("-", "")}`;
  const url = new URL(admin_url);
  url.pathname = `/${name}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const first = PgPostgresExecutor.connect(url.href);
  const second = PgPostgresExecutor.connect(url.href);
  try {
    await Promise.all([migrateEmptyDatabase(first), migrateEmptyDatabase(second)]);
    const baselines = await first.query<{ count: number }>("SELECT count(*)::int AS count FROM authority.schema_baseline", []);
    expect(baselines[0]?.count).toBe(1);
  } finally {
    await Promise.all([first.close(), second.close()]);
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
});

test("inbox materializes each distinct pinned bundle source once", async () => {
  const fetched: string[] = [];
  const tx = { query: async <Row extends object>(sql: string, parameters: readonly unknown[]): Promise<readonly Row[]> => {
    if (sql.includes("FROM authority.scope_instance")) return [
      { id: "scope-1", run_id: "run-1", definition_bundle_id: "bundle-1", version: 0, scope_key: "root", is_terminal: true },
      { id: "scope-2", run_id: "run-1", definition_bundle_id: "bundle-1", version: 0, scope_key: "root", is_terminal: true },
    ] as unknown as readonly Row[];
    if (sql.includes("FROM authority.definition_bundle")) {
      fetched.push(String(parameters[0]));
      return [{ id: "bundle-1", source: { scopes: [{ key: "root", commands: [] }] } }] as unknown as readonly Row[];
    }
    return [];
  } };
  const db = { query: tx.query, transaction: async (operation: (executor: typeof tx) => Promise<unknown>) => operation(tx) } as unknown as TransactionalSqlExecutor;
  const page = await readInbox(db);
  expect(page.cursor).toHaveLength(2);
  expect(fetched).toHaveLength(1);
});

test("bundle content hash is stable across equivalent sources and refuses cycles", () => {
  expect(bundleContentHash({ key: "one", nested: [1, 2] })).toBe(bundleContentHash({ key: "one", nested: [1, 2] }));
  expect(bundleContentHash({ key: "two" })).not.toBe(bundleContentHash({ key: "one" }));
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  expect(() => bundleContentHash(cycle)).toThrow("cycle");
});

test("run and definition pages expose stable next cursors and refuse malformed cursors", async () => {
  const ids = ["00000000-0000-0000-0000-000000000002", "00000000-0000-0000-0000-000000000001"];
  const query = async <Row extends object>(sql: string, parameters: readonly unknown[]): Promise<readonly Row[]> => {
    if (sql.includes("SELECT id AS run_id,created_at FROM authority.run")) {
      const after = parameters[1];
      return ids.filter((id) => typeof after !== "string" || id < after).map((id) => ({ run_id: id, created_at: new Date("2026-01-01T00:00:00.000Z") })).slice(0, Number(parameters[2])) as unknown as readonly Row[];
    }
    if (sql.includes("SELECT * FROM authority.run WHERE id=")) return [{ id: parameters[0], definition_bundle_id: ids[0], version: 0 }] as unknown as readonly Row[];
    if (sql.includes("SELECT source,digest FROM authority.definition_bundle")) return [{ source: { scopes: [] }, digest: "digest" }] as unknown as readonly Row[];
    if (sql.includes("SELECT * FROM authority.scope_instance WHERE run_id=")) return [];
    if (sql.includes("FROM authority.definition_bundle")) return ids.filter((id) => typeof parameters[0] !== "string" || id < parameters[0])
      .map((id) => ({ bundle_id: id, digest: id, source: { key: id, scopes: [] } })).slice(0, Number(parameters[1])) as unknown as readonly Row[];
    return [];
  };
  const db = { query, transaction: async (operation: (tx: { query: typeof query }) => Promise<unknown>) => operation({ query }) } as unknown as TransactionalSqlExecutor;
  const app = new Hono();
  installDefinitionApi(app, { db, core: {} as CoreClient, mutations: {} as MutationService, wake: async () => undefined });
  for (const path of ["/api/runs", "/api/definitions"]) {
    const first = await app.request(`${path}?limit=1`);
    expect(first.status).toBe(200);
    const first_page: { items: unknown[]; next_cursor: string | null } = await first.json();
    expect(first_page.items).toHaveLength(1);
    expect(first_page.next_cursor).not.toBeNull();
    const second = await app.request(`${path}?limit=1&cursor=${encodeURIComponent(first_page.next_cursor ?? "")}`);
    expect((await second.json() as { items: unknown[]; next_cursor: string | null }).items).toHaveLength(1);
    expect((await app.request(`${path}?cursor=invalid`)).status).toBe(400);
  }
});

/**
 * The exact body kbbl's `isSessionHold` must accept: recorded here, from the
 * real route, rather than hand-rolled — a shared literal that proves the two
 * sides agree rather than merely declaring that they should.
 */
test("GET /api/session_holds/:sid returns the body kbbl's isSessionHold accepts", async () => withDatabase(async ({ db }) => {
  await db.query("INSERT INTO authority.definition_bundle (id,digest,source,checked_program) VALUES ('bundle','digest','{}','{}')", []);
  await db.query("INSERT INTO authority.run (id,definition_bundle_id) VALUES ('run','bundle')", []);
  await db.query("INSERT INTO authority.scope_instance (id,run_id,scope_key,child_key,input,local_state) VALUES ('scope','run','spec_analyzer','0','{}','{}')", []);
  await db.query("INSERT INTO authority.execution (id,scope_id,worker_key,generation,status) VALUES ('execution-1','scope','agent',1,'pending')", []);
  const held = sealEffectPayload({ action: "start", handle: { kind: "kbbl_session", session_id: "session-1" },
    invocation: { id: "invocation-1", execution_id: "execution-1", selection: {}, bytes: "unused" } } as unknown as EffectPayload);
  await db.query("INSERT INTO authority.effect_intent (id,scope_id,execution_id,effect_key,payload,status) VALUES ('start','scope','execution-1','ingress:0',$1,'acknowledged')", [JSON.stringify(held)]);

  const app = new Hono();
  installDefinitionApi(app, { db, core: {} as CoreClient, mutations: {} as MutationService, wake: async () => undefined });
  const response = await app.request("/api/session_holds/session-1");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ held: true, hold: {
    session_id: "session-1", execution_id: "execution-1", run_id: "run", stage_instance_id: "scope", stage_key: "spec_analyzer", unit_id: "0",
  } });

  expect(await (await app.request("/api/session_holds/no-such-session")).json()).toEqual({ held: false, hold: null });
}));

test("every table write rejects non-JSON bodies and unlisted browser origins on both paths", async () => {
  const previous = process.env.OAKRIDGE_ALLOWED_ORIGINS;
  process.env.OAKRIDGE_ALLOWED_ORIGINS = "https://operator.example";
  try {
    await withDatabase(async ({ url }) => {
      const composition = await createProductionComposition({ database_url: url,
        core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), host: "127.0.0.1" });
      const proxy = new Hono();
      mountOakridgeProxyRoutes(proxy, { baseUrl: "http://oakridge.test", allowedOrigins: ["https://operator.example"] });
      try {
        for (const route of activeRoutes(process.env.OAKRIDGE_ENABLE_RAW_INGRESS === "1").filter((item) => item.method !== "GET")) {
          const path = route.path.replace(/:[^/]+/g, "id");
          for (const [headers, expected] of [
            [{ "content-type": "text/plain" }, 415],
            [{ "content-type": "application/json", origin: "http://127.0.0.1:5173" }, 403],
          ] as const) {
            const options = { method: route.method, headers: new Headers(headers), body: "{}" };
            expect((await composition.app.request(path, options)).status).toBe(expected);
            expect((await proxy.request(`/oakridge/api${path}`, options)).status).toBe(expected);
          }
        }
      } finally { await composition.close(); }
    });
  } finally {
    if (previous === undefined) delete process.env.OAKRIDGE_ALLOWED_ORIGINS;
    else process.env.OAKRIDGE_ALLOWED_ORIGINS = previous;
  }
});

test("recovery replays the pinned prompt verbatim and its secret publishes without operator authority", async () => {
  const requests: string[] = [];
  const adapter = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    if (request.method === "PUT") {
      requests.push(await request.text());
      if (requests.length === 1) return new Response("response lost", { status: 503 });
      return Response.json({ kind: "attached", session: { sid: "recovered-session", status: "live" } });
    }
    if (request.method === "DELETE") return Response.json({ stopped: true });
    return Response.json({ pending: true }, { status: 202 });
  } });
  try {
    await withDatabase(async ({ url, db }) => {
      const composition = await createProductionComposition({ database_url: url,
        core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), host: "127.0.0.1",
        control_token: "operator-only", kbbl_base_url: adapter.url.href,
        provider_capabilities: { check_github: async () => ({ ok: true, value: true }) },
        timing: { retry_initial_seconds: 0.05, retry_cap_seconds: 0.2, observe_interval_seconds: 0.05, wake_timeout_seconds: 1 } });
      try {
        const headers = { "content-type": "application/json", authorization: "Bearer operator-only" };
        const created = await composition.app.request("/runs", { method: "POST", headers,
          body: JSON.stringify({ bundle: await developmentBundle(), input: { brief, repository, push_remote_owner: repository.forge.owner } }) });
        expect(created.status).toBe(201);
        const run: StartedRun = await created.json();
        const scope_path = `/api/runs/${run.run_id}/scopes/${run.root_scope_id}`;
        const begin = await composition.app.request(`${scope_path}/commands`, { method: "POST", headers,
          body: JSON.stringify({ command_key: "begin", payload: {}, request_id: "begin", scope_id: run.root_scope_id,
            expected_scope_version: 0, targets: [] }) });
        expect(begin.status).toBe(202);
        await waitUntil(async () => requests.length >= 2);
        const stored = (await db.query<{ id: string; payload: EffectPayload }>(
          "SELECT id,payload FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='start'", [run.root_scope_id]))[0];
        const pinned = stored ? (await readIntent(db, stored.id))?.payload.invocation : null;
        if (!pinned) throw new Error("persisted invocation missing");
        expect(requests).toEqual(requests.map(() => pinned.bytes));
        const secret = requests[1]?.match(/Authorization: Bearer ([A-Za-z0-9_-]+)/)?.[1];
        if (!secret) throw new Error("replayed prompt lacks publication credential");
        expect(JSON.stringify(stored?.payload)).not.toContain(secret);
        expect(stored?.payload.invocation.bytes.startsWith("enc:v1:")).toBe(true);
        const execution_path = `${scope_path}/executions/${pinned.execution_id}`;
        expect((await composition.app.request(`${execution_path}/contract`, {
          headers: { authorization: `Bearer ${secret}` } })).status).toBe(200);
        const publication = await composition.app.request(`${execution_path}/outputs/build_result`, { method: "PUT",
          headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
          body: JSON.stringify({ request_id: "replayed-agent", predecessor_id: null, collection_key: "", body: build_body }) });
        expect({ status: publication.status, body: await publication.json() }).toMatchObject({ status: 201, body: { kind: "accepted_pending" } });
        expect((await composition.app.request(scope_path, { headers: { authorization: "Bearer operator-only" } })).status).toBe(200);
        expect((await composition.app.request(scope_path, { headers: { authorization: `Bearer ${secret}` } })).status).toBe(401);
      } finally { await composition.close(); }
    });
  } finally { adapter.stop(true); }
});

test("the composed app registers exactly the active route table and gates raw ingress", async () => {
  const previous = process.env.OAKRIDGE_ENABLE_RAW_INGRESS;
  try {
    for (const enabled of [false, true]) {
      if (enabled) process.env.OAKRIDGE_ENABLE_RAW_INGRESS = "1";
      else delete process.env.OAKRIDGE_ENABLE_RAW_INGRESS;
      await withDatabase(async ({ url }) => {
        const composition = await createProductionComposition({ database_url: url,
          core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), host: "127.0.0.1" });
        try {
          const registered = composition.app.routes.filter((route) => route.method !== "ALL")
            .map((route) => `${route.method} ${route.path}`).sort();
          expect(registered).toEqual(activeRoutes(enabled).map((route) => `${route.method} ${route.path}`).sort());
          const response = await composition.app.request("/runs/missing/scopes/missing/decide", {
            method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
          expect(response.status).toBe(enabled ? 400 : 404);
        } finally { await composition.close(); }
      });
    }
  } finally {
    if (previous === undefined) delete process.env.OAKRIDGE_ENABLE_RAW_INGRESS;
    else process.env.OAKRIDGE_ENABLE_RAW_INGRESS = previous;
  }
});

test("rejection after uncertainty cleans up even when its evidence makes the run terminal", async () => withDatabase(async ({ url, db }) => {
  let starts = 0;
  const stopped: StableInvocation[] = [];
  let can_confirm_stop = false;
  const composition = await createProductionComposition({ database_url: url, core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), host: "127.0.0.1",
    timing: { retry_initial_seconds: 0.01, retry_cap_seconds: 0.05, wake_timeout_seconds: 0.05 },
    effect_provider: {
      start: async () => ++starts === 1 ? { kind: "uncertain", detail: "start response lost" }
        : { kind: "permanently_rejected", code: "worktree_unrecoverable", detail: "reconciliation rejected",
          evidence: { id: "rejection", key: "worktree_unrecoverable", payload: { schema: "text", data: { kind: "string", value: "reconciliation rejected" } } } },
      observe: async () => { throw new Error("rejected starts must not be observed"); },
      stop: async (invocation) => {
        stopped.push(invocation);
        return can_confirm_stop ? { kind: "acknowledged", value: { stopped: true } } : { kind: "uncertain", detail: "stop response lost" };
      },
    } });
  try {
    const shipped = await operationBundle("repository.prepare");
    const root = shipped.scopes[0]!;
    if (root.tree.kind !== "match") throw new Error("effect fixture must dispatch facts");
    const bundle: DefinitionBundle = { ...shipped, scopes: [{ ...root,
      facts: [...root.facts, { key: "worktree_unrecoverable", payload_schema: "text" }],
      tree: { ...root.tree, cases: [...root.tree.cases, { variant: "worktree_unrecoverable",
        node: { kind: "apply", id: "worktree_unrecoverable", actions: [], mutations: [],
          outcome: { kind: "literal", schema: "result", value: { kind: "withdrawn", value: {} } } } }] } }] };
    const run = await begin(composition, bundle, { repository_path: "/tmp", expected_head: null });
    await waitUntil(async () => stopped.length > 0 && (await db.query<{ is_terminal: boolean }>("SELECT is_terminal FROM authority.scope_instance WHERE id=$1", [run.root_scope_id]))[0]?.is_terminal === true);
    const deletion = await composition.app.request(`http://localhost/runs/${run.run_id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: "{}" });
    expect(deletion.status).toBe(409);
    can_confirm_stop = true;
    await waitUntil(async () => (await db.query<{ status: string }>("SELECT status FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='stop'", [run.root_scope_id]))[0]?.status === "cleanup_confirmed");
    const start = await db.query<{ payload: EffectPayload }>("SELECT payload FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='start'", [run.root_scope_id]);
    expect(stopped.every((invocation) => invocation.bytes === (start[0] ? unsealEffectPayload(start[0].payload).invocation.bytes : null))).toBe(true);
    expect((await composition.app.request(`http://localhost/runs/${run.run_id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(200);
  } finally { await composition.close(); }
}));

test("observe rejection settles, delivers evidence, and cleans up its acknowledged session", async () => withDatabase(async ({ url, db }) => {
  let stops = 0;
  const composition = await createProductionComposition({ database_url: url,
    core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), host: "127.0.0.1",
    timing: { retry_initial_seconds: 0.01, retry_cap_seconds: 0.05, observe_interval_seconds: 0.01, wake_timeout_seconds: 0.05 },
    effect_provider: {
      start: async () => ({ kind: "acknowledged", value: { kind: "kbbl_session", session_id: "session" } }),
      observe: async () => ({ kind: "permanently_rejected", code: "session_failed", detail: "provider rejected observation",
        evidence: { id: "terminal-error", key: "session_failed", payload: { schema: "text", data: { kind: "string", value: "provider rejected observation" } } } }),
      stop: async () => { stops++; return { kind: "acknowledged", value: { stopped: true } }; },
    } });
  try {
    const run = await begin(composition, await sessionBundle(), { runtime: "claude-code", rendered_prompt: "publish", workdir: "/tmp", session_name: "rejected",
      session_identity: {}, worktree: { branchName: "selected", worktreeSubdir: "selected" } });
    await waitUntil(async () => (await db.query<{ status: string }>("SELECT status FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='stop'", [run.root_scope_id]))[0]?.status === "cleanup_confirmed");
    expect((await db.query<{ status: string }>("SELECT status FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='start'", [run.root_scope_id]))[0]?.status).toBe("rejected");
    expect((await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.fact WHERE scope_id=$1 AND fact_key='session_failed'", [run.root_scope_id]))[0]?.count).toBe("1");
    expect(stops).toBe(1);
  } finally { await composition.close(); }
}));

test("production prepares the selected repository and routes durable results into configured scope decisions", async () => {
  await withDatabase(async ({ url, db }) => {
    const composition = await createProductionComposition({ database_url: url, core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), host: "127.0.0.1", timing: { retry_initial_seconds: 0.05, retry_cap_seconds: 0.2, observe_interval_seconds: 0.05, wake_timeout_seconds: 1 } });
    try {
      const bundle = await operationBundle("repository.prepare");
      const run = await begin(composition, bundle, { repository_path: resolve(import.meta.dir, "../.."), expected_head: null });
      await waitUntil(async () => (await db.query<{ is_terminal: boolean }>("SELECT is_terminal FROM authority.scope_instance WHERE id=$1", [run.root_scope_id]))[0]?.is_terminal === true);
      const facts = await db.query<{ fact_key: string }>("SELECT fact_key FROM authority.fact WHERE scope_id=$1", [run.root_scope_id]);
      expect(facts.some((fact) => fact.fact_key === "prepared")).toBe(true);
      const source = await readSnapshot(db, run.root_scope_id, { id: "tick", key: "tick", payload: unit });
      expect(source?.snapshot.observations).toEqual([]);
      const effects = await db.query<{ payload: EffectPayload; status: string }>("SELECT payload,status FROM authority.effect_intent WHERE scope_id=$1", [run.root_scope_id]);
      expect(effects[0]?.status).toBe("cleanup_confirmed");
      expect(effects[0]?.payload.invocation.selection.definition.operation).toBe("repository.prepare");
    } finally { await composition.close(); }
  });
});

test("production rejects a lost worktree when the shipped scope declares no recovery fact", async () => {
  await withDatabase(async ({ url, db }) => {
    const composition = await createProductionComposition({ database_url: url, core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), host: "127.0.0.1", timing: { retry_initial_seconds: 0.05, retry_cap_seconds: 0.2, observe_interval_seconds: 0.05, wake_timeout_seconds: 1 } });
    try {
      const run = await begin(composition, await operationBundle("repository.prepare"), { repository_path: `/tmp/missing-${crypto.randomUUID()}`, expected_head: null });
      await waitUntil(async () => (await db.query<{ status: string }>("SELECT status FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='start'", [run.root_scope_id]))[0]?.status === "rejected");
      expect((await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.fact WHERE fact_key='worktree_unrecoverable'", []))[0]?.count).toBe("0");
    } finally { await composition.close(); }
  });
});

test("production PR discovery retries a real HTTP 503 and persists its selected result fact", async () => {
  let is_available = false;
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
    calls++;
    if (!is_available) return new Response("unavailable", { status: 503 });
    return new URL(request.url).pathname.endsWith("/pulls") ? Response.json([{ number: 1, head: { ref: "head", repo: { full_name: "owner/repo" } }, base: { ref: "base" } }])
      : Response.json({ number: 1, html_url: "https://forge/pr/1", state: "open", head: { ref: "head", sha: "a".repeat(40) }, base: { ref: "base" }, merged: false, merged_at: null });
  } });
  try {
    await withDatabase(async ({ url, db }) => {
      const reader = new GithubPullRequestReader({ token: "test", api_base_url: server.url.href });
      const composition = await createProductionComposition({ database_url: url, core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), host: "127.0.0.1", pull_requests: reader, provider_capabilities: { check_github: async () => ({ ok: true, value: true }) }, timing: { retry_initial_seconds: 0.05, retry_cap_seconds: 0.2, observe_interval_seconds: 0.05, wake_timeout_seconds: 1 } });
      try {
        const run = await begin(composition, await operationBundle("pull_request.observe"), { query: { owner: "owner", name: "repo", head_owner: "owner", head_branch: "head", base_branch: "base" } });
        await waitUntil(async () => calls >= 1 && (await db.query<{ status: string }>("SELECT status FROM authority.effect_intent WHERE scope_id=$1", [run.root_scope_id]))[0]?.status === "pending");
        const before = await db.query<{ payload: EffectPayload }>("SELECT payload FROM authority.effect_intent WHERE scope_id=$1", [run.root_scope_id]);
        is_available = true;
        await waitUntil(async () => (await db.query<{ is_terminal: boolean }>("SELECT is_terminal FROM authority.scope_instance WHERE id=$1", [run.root_scope_id]))[0]?.is_terminal === true);
        const after = await db.query<{ payload: EffectPayload }>("SELECT payload FROM authority.effect_intent WHERE scope_id=$1", [run.root_scope_id]);
        expect(after[0] && unsealEffectPayload(after[0].payload).invocation.bytes)
          .toBe(before[0] && unsealEffectPayload(before[0].payload).invocation.bytes);
        expect((await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.fact WHERE fact_key='pr_observed'", []))[0]?.count).toBe("1");
      } finally { await composition.close(); }
    });
  } finally { server.stop(true); }
});

test("GitHub 403 publishes a typed auth fact and does not retry", async () => {
  let calls = 0;
  const reader = new GithubPullRequestReader({ token: "restricted", api_base_url: "http://unused" }, (async () => {
    calls++;
    return new Response("forbidden", { status: 403 });
  }) as unknown as typeof fetch);
  await withDatabase(async ({ url, db }) => {
    const composition = await createProductionComposition({ database_url: url, core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"),
      host: "127.0.0.1", pull_requests: reader, provider_capabilities: { check_github: async () => ({ ok: true, value: true }) }, timing: { retry_initial_seconds: 0.05, retry_cap_seconds: 0.2, observe_interval_seconds: 0.05, wake_timeout_seconds: 1 } });
    try {
      const run = await begin(composition, await operationBundle("pull_request.observe"), { query: { owner: "owner", name: "repo", head_owner: "owner", head_branch: "head", base_branch: "base" } });
      await waitUntil(async () => (await db.query<{ is_terminal: boolean }>("SELECT is_terminal FROM authority.scope_instance WHERE id=$1", [run.root_scope_id]))[0]?.is_terminal === true);
      const facts = await db.query<{ fact_key: string }>("SELECT fact_key FROM authority.fact WHERE scope_id=$1", [run.root_scope_id]);
      expect({ calls, has_auth_fact: facts.some((fact) => fact.fact_key === "auth") }).toEqual({ calls: 1, has_auth_fact: true });
    } finally { await composition.close(); }
  });
});

test("a shipped unit session result commits an execution and confirms cleanup", async () => {
  let observations = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
    if (request.method === "PUT") return Response.json({ kind: "attached", session: { sid: "completed-session", status: "live" } });
    if (++observations === 1) return Response.json({ lastActivityTs: Date.now() }, { status: 202 });
    return Response.json({ session: { endReason: "subprocess_exited" }, exit_code: 0 });
  } });
  try {
    await withDatabase(async ({ url, db }) => {
      const composition = await createProductionComposition({ database_url: url,
        core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"),
        host: "127.0.0.1", kbbl_base_url: server.url.href,
        timing: { retry_initial_seconds: 0.05, retry_cap_seconds: 0.2, observe_interval_seconds: 0.05, wake_timeout_seconds: 1 } });
      try {
        const run = await begin(composition, await sessionBundle(), { runtime: "claude-code", rendered_prompt: "publish the result", workdir: "/tmp", session_name: "completed",
          session_identity: {}, worktree: { branchName: "selected", worktreeSubdir: "selected" } });
        await waitUntil(async () => (await db.query<{ status: string }>("SELECT status FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='start'", [run.root_scope_id]))[0]?.status === "cleanup_confirmed");
        expect((await db.query<{ status: string; result: CheckedValue }>("SELECT status,result FROM authority.execution WHERE scope_id=$1", [run.root_scope_id]))[0])
          .toMatchObject({ status: "terminal", result: { schema: "unit", data: { kind: "record", fields: [] } } });
        expect(observations).toBeGreaterThanOrEqual(2);
      } finally { await composition.close(); }
    });
  } finally { server.stop(true); }
});

test("changed repository head and PR observations cannot enrich a selected kbbl request on replay", async () => {
  const { sessionBundle } = await import("./effect-fixture");
  const requests: string[] = [];
  let should_attach = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    if (request.method === "PUT") {
      requests.push(await request.text());
      return should_attach ? Response.json({ kind: "attached", session: { sid: "one-session", status: "live" } }) : new Response("accepted, response lost", { status: 503 });
    }
    if (request.method === "DELETE") return Response.json({ stopped: true });
    return Response.json({ pending: true }, { status: 202 });
  } });
  try {
    await withDatabase(async ({ url, db }) => {
      const composition = await createProductionComposition({ database_url: url, core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), host: "127.0.0.1", kbbl_base_url: server.url.href,
        timing: { retry_initial_seconds: 0.05, retry_cap_seconds: 0.2, observe_interval_seconds: 0.05, wake_timeout_seconds: 1 } });
      try {
        const selected_head = "a".repeat(40);
        const run = await begin(composition, await sessionBundle(), { runtime: "claude-code", rendered_prompt: `Review PR 1 at ${selected_head}`, workdir: "/tmp", session_name: "replay",
          session_identity: { run_id: "selected-run", stage_instance_id: "selected-scope", unit_id: "author" }, worktree: { branchName: "selected", worktreeSubdir: "selected", baseRef: selected_head } });
        await waitUntil(async () => requests.length >= 1 && (await db.query<{ payload: EffectPayload }>("SELECT payload FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='start'", [run.root_scope_id]))[0]?.payload.has_uncertain_start === true);
        for (const key of ["repository", "pull_request"]) {
          const changed: CheckedValue = { schema: "metadata", data: { kind: "record", fields: [], dictionary: [{ key: key === "repository" ? "head" : "url", value: { schema: "text", data: { kind: "string", value: key === "repository" ? "b".repeat(40) : "https://forge/pr/2" } } }] } };
          await db.query("INSERT INTO authority.resource_binding (id,scope_id,resource_key,observation) VALUES ($1,$2,$3,$4)", [key, run.root_scope_id, key, JSON.stringify(changed)]);
        }
        should_attach = true;
        await waitUntil(async () => (await db.query<{ status: string }>("SELECT status FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='start'", [run.root_scope_id]))[0]?.status === "acknowledged");
        expect(requests.length).toBeGreaterThanOrEqual(2);
        expect(new Set(requests).size).toBe(1);
        const cancelled = await composition.app.request(`http://localhost/runs/${run.run_id}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "cancel_run", reason: "operator" }) });
        expect(await cancelled.json()).toMatchObject({ kind: "cancelled" });
        await waitUntil(async () => (await db.query<{ status: string }>("SELECT status FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='stop'", [run.root_scope_id]))[0]?.status === "cleanup_confirmed");
      } finally { await composition.close(); }
    });
  } finally { server.stop(true); }
});

// ---- kbbl service credential ----

function withEnv(name: string, value: string | undefined, operation: () => Promise<void>): Promise<void> {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  return operation().finally(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
}

test("createProductionComposition refuses a non-loopback KBBL_BASE_URL with no configured credential", async () =>
  withEnv("OAKRIDGE_KBBL_SERVICE_TOKEN", undefined, () => withDatabase(async ({ url }) => {
    await expect(createProductionComposition({ database_url: url, core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"),
      host: "127.0.0.1", kbbl_base_url: "https://kbbl.example.com" })).rejects.toThrow(/OAKRIDGE_KBBL_SERVICE_TOKEN/);
  })));

test("a startup probe kbbl rejects aborts startup before DBOS.launch()", async () =>
  withEnv("OAKRIDGE_KBBL_SERVICE_TOKEN", "wrong-token", () => withDatabase(async ({ url }) => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "DELETE" && path === "/sessions/startup-probe") return new Response(null, { status: 403 });
      return new Response(null, { status: 404 });
    } });
    try {
      await expect(createProductionComposition({ database_url: url, core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"),
        host: "127.0.0.1", kbbl_base_url: server.url.href })).rejects.toThrow(/did not accept/);
    } finally { server.stop(true); }
  })));

/**
 * A 404 (wrong base URL, or a service that is not kbbl at all) or a 5xx
 * (kbbl down) must abort startup exactly as an explicit 401/403 does: the
 * probe's only job is to confirm the credential was accepted, and treating
 * "not an auth rejection" as "accepted" lets a misconfigured or unreachable
 * kbbl through without ever proving that.
 */
test("a startup probe response that is not kbbl's authenticated sentinel aborts startup", async () =>
  withEnv("OAKRIDGE_KBBL_SERVICE_TOKEN", "configured-token", () => withDatabase(async ({ url }) => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("not found", { status: 404 }) });
    try {
      await expect(createProductionComposition({ database_url: url, core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"),
        host: "127.0.0.1", kbbl_base_url: server.url.href })).rejects.toThrow(/did not accept/);
    } finally { server.stop(true); }
  })));

test("kbbl's authenticated invalid-sid sentinel lets startup proceed", async () =>
  withEnv("OAKRIDGE_KBBL_SERVICE_TOKEN", "configured-token", () => withDatabase(async ({ url }) => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "DELETE" && path === "/sessions/startup-probe") return Response.json({ error: "invalid sid" }, { status: 400 });
      return new Response(null, { status: 404 });
    } });
    try {
      const composition = await createProductionComposition({ database_url: url, core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"),
        host: "127.0.0.1", kbbl_base_url: server.url.href });
      try { expect(composition.application_version).toBeTruthy(); } finally { await composition.close(); }
    } finally { server.stop(true); }
  })));

test("an injected effect_provider skips the startup probe and performs no kbbl network IO", async () =>
  withEnv("OAKRIDGE_KBBL_SERVICE_TOKEN", "configured-token", () => withDatabase(async ({ url }) => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => { calls++; return originalFetch(...args); }) as typeof fetch;
    try {
      const composition = await createProductionComposition({ database_url: url, core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"),
        host: "127.0.0.1", kbbl_base_url: "https://kbbl.invalid",
        effect_provider: {
          start: async () => { throw new Error("must not be called: probe should not reach the production provider"); },
          observe: async () => { throw new Error("must not be called: probe should not reach the production provider"); },
          stop: async () => { throw new Error("must not be called: probe should not reach the production provider"); },
        } });
      try { expect(composition.application_version).toBeTruthy(); } finally { await composition.close(); }
      expect(calls).toBe(0);
    } finally { globalThis.fetch = originalFetch; }
  })));
