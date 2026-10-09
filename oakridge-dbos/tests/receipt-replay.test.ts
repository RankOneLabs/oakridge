import { expect, test } from "bun:test";
import { Pool } from "pg";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { readSnapshot } from "../src/storage/snapshot-reader";
import { commitDecision, type CommitRequest } from "../src/storage/commit";
import { requestDigest } from "../src/storage/receipts";
import type { CheckedValue } from "../src/core-client/generated-contracts";
import type { RunId, ScopeId } from "../src/storage/schema-records";
import { withDatabase } from "./effect-fixture";
import { brief, build_body, developmentBundle, repository, runtimeFixture } from "./development-runtime-fixture";

test("receipt digest is stable when nested map keys arrive in another order", () => {
  expect(requestDigest({ z: { ä: 1, a: 2 }, a: [1, { y: true, x: false }] }))
    .toBe(requestDigest({ a: [1, { x: false, y: true }], z: { a: 2, ä: 1 } }));
});

test("exact ingress replay returns its receipt after terminal state; changed digest conflicts", async () => {
  const admin_url = process.env.OAKRIDGE_TEST_DATABASE_URL;
  if (!admin_url) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required for PostgreSQL receipt tests");
  const name = `receipt_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: admin_url });
  const url = new URL(admin_url); url.pathname = `/${name}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const db = PgPostgresExecutor.connect(url.href);
  const value: CheckedValue = { schema: "unit", data: { kind: "record", fields: [], dictionary: [] } };
  try {
    await migrateEmptyDatabase(db);
    await db.query("INSERT INTO authority.definition_bundle (id,digest,source,checked_program) VALUES ('bundle','digest',$1,$2)", [JSON.stringify({ limits: { max_depth: 64, max_list_items: 100 }, schemas: [{ key: "unit", shape: { kind: "record", fields: [], dictionary: null } }], scopes: [{ key: "root", tree: { kind: "wait", reason: "storage fixture" }, commands: [], state_schema: "unit", outcome_schema: "unit", children: [], exports: [], resources: [], workers: [], pools: [{ key: "workers", limit: 1 }], outputs: [] }] }), JSON.stringify({ digest: "digest", scopes: [{ key: "root", reads: [] }] })]);
    await db.query("INSERT INTO authority.run (id,definition_bundle_id) VALUES ('run','bundle')", []);
    await db.query("INSERT INTO authority.scope_instance (id,run_id,scope_key,input,local_state) VALUES ('scope','run','root',$1,$1)", [JSON.stringify(value)]);
    const source = (await readSnapshot(db, "scope" as ScopeId, { id: "t", key: "start", payload: value }))!;
    const request: CommitRequest = {
      identity: { run_id: "run" as RunId, scope_id: "scope" as ScopeId, ingress_id: "request", request_digest: "one" },
      read_set: source.read_set, operator_version: null, outputs: [], capacity: [], effects: [],
      decision: { kind: "wait", reason: "pause", continuations: [], explanation: { bundle_digest: "digest", node_id: "n", owner: "scope", read_set: [], trace: [], trigger_id: "t" } },
    };
    const first = await commitDecision(db, request, source);
    expect(first.ok && first.value.kind).toBe("Committed");
    await db.query("UPDATE authority.scope_instance SET is_terminal=true,version=version+1 WHERE id='scope'", []);
    const replay = await commitDecision(db, request, source);
    expect(replay.ok && replay.value.kind === "Replayed" && replay.value.receipt).toEqual(first.ok && first.value.kind === "Committed" && first.value.receipt);
    const conflict = await commitDecision(db, { ...request, identity: { ...request.identity, request_digest: "changed" } }, source);
    expect(conflict.ok && conflict.value.kind).toBe("Conflict");
    const transitions = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.transition", []);
    expect(transitions[0]?.count).toBe("1");
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
});

test("a committed publication retried after its execution reaches terminal replays instead of 403", async () => withDatabase(async ({ db }) => {
  const f = await runtimeFixture(db, await developmentBundle(), { brief, repository });
  try {
    await f.fact("begin");
    const execution = await f.selected("build");
    const secret = await f.publicationSecret(execution);
    const endpoint = `http://localhost/api/runs/${f.run_id}/scopes/${f.root_scope_id}/executions/${execution}/outputs/build_result`;
    const payload = { request_id: "terminal-retry", predecessor_id: null, collection_key: "", body: build_body };
    const publish = () => f.app.request(endpoint, { method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify(payload) });
    const first = await publish();
    expect(first.status).toBe(201);
    const receipt = await first.json();
    await db.query("UPDATE authority.execution SET status='terminal' WHERE id=$1", [execution]);
    const retry = await publish();
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(receipt);
  } finally { f.core.close(); }
}));
