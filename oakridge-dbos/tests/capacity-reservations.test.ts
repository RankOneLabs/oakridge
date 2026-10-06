import { expect, test } from "bun:test";
import { Pool } from "pg";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { readSnapshot } from "../src/storage/snapshot-reader";
import { commitDecision, type CommitRequest } from "../src/storage/commit";
import type { CheckedValue } from "../src/core-client/generated-contracts";
import type { PoolId, RunId, ScopeId } from "../src/storage/schema-records";

test("concurrent acquisitions never overbook a one-slot pool", async () => {
  const admin_url = process.env.OAKRIDGE_TEST_DATABASE_URL;
  if (!admin_url) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required for PostgreSQL capacity tests");
  const name = `capacity_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: admin_url });
  const url = new URL(admin_url); url.pathname = `/${name}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const db = PgPostgresExecutor.connect(url.href);
  const value: CheckedValue = { schema: "unit", data: { kind: "record", fields: [], dictionary: [] } };
  try {
    await migrateEmptyDatabase(db);
    await db.query("INSERT INTO authority.definition_bundle (id,digest,source,checked_program) VALUES ('bundle','digest',$1,'{}')", [JSON.stringify({ limits: { max_depth: 64, max_list_items: 100 }, schemas: [{ key: "unit", shape: { kind: "record", fields: [], dictionary: null } }], scopes: [{ key: "root", tree: { kind: "wait", reason: "storage fixture" }, commands: [], state_schema: "unit", outcome_schema: "unit", children: [], exports: [], resources: [], workers: [], pools: [{ key: "workers", limit: 1 }], outputs: [] }] })]);
    await db.query("INSERT INTO authority.run (id,definition_bundle_id) VALUES ('run','bundle')", []);
    for (const id of ["one", "two"]) await db.query("INSERT INTO authority.scope_instance (id,run_id,scope_key,input,local_state) VALUES ($1,'run','root',$2,$2)", [id, JSON.stringify(value)]);
    await db.query("INSERT INTO authority.capacity_pool (id,run_id,pool_key,capacity) VALUES ('pool','run','workers',1)", []);
    const requests: { request: CommitRequest; source: NonNullable<Awaited<ReturnType<typeof readSnapshot>>> }[] = [];
    for (const id of ["one", "two"]) {
      const source = (await readSnapshot(db, id as ScopeId, { id, key: "start", payload: value }))!;
      requests.push({ source, request: {
        identity: { run_id: "run" as RunId, scope_id: id as ScopeId, ingress_id: id, request_digest: id }, read_set: source.read_set, operator_version: null,
        decision: { kind: "apply", explanation: { bundle_digest: "digest", node_id: "n", owner: id, read_set: [], trace: [], trigger_id: id }, mutations: [{ kind: "acquire", pool: "workers" }], invocations: [], targets: [] },
        capacity: [{ kind: "acquire", pool_id: "pool" as PoolId, scope_id: id as ScopeId }], outputs: [], effects: [],
      } });
    }
    const outcomes = await Promise.all(requests.map(({ request, source }) => commitDecision(db, request, source)));
    expect(outcomes.filter((result) => result.ok && result.value.kind === "Committed")).toHaveLength(1);
    const active = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.capacity_reservation WHERE is_active", []);
    expect(active[0]?.count).toBe("1");
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
});
