import { expect, test } from "bun:test";
import { Pool } from "pg";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { readSnapshot } from "../src/storage/snapshot-reader";
import { commitDecision, type CommitRequest } from "../src/storage/commit";
import type { CheckedValue } from "../src/core-client/generated-contracts";
import type { PoolId, RunId, ScopeId } from "../src/storage/schema-records";

async function runCapacityCase(pool_keys: readonly [string, string]) {
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
    const scopes = pool_keys.map((pool_key, index) => ({ key: `scope_${index}`, tree: { kind: "wait", reason: "storage fixture" }, commands: [], state_schema: "unit", outcome_schema: "unit", children: [], exports: [], resources: [], workers: [], pools: [{ key: pool_key, limit: 1 }], outputs: [] }));
    await db.query("INSERT INTO authority.definition_bundle (id,digest,source,checked_program) VALUES ('bundle','digest',$1,$2)", [JSON.stringify({ limits: { max_depth: 64, max_list_items: 100 }, schemas: [{ key: "unit", shape: { kind: "record", fields: [], dictionary: null } }], scopes }), JSON.stringify({ digest: "digest", scopes: scopes.map((scope) => ({ key: scope.key, reads: [] })) })]);
    await db.query("INSERT INTO authority.run (id,definition_bundle_id) VALUES ('run','bundle')", []);
    for (const [index, id] of ["one", "two"].entries()) await db.query("INSERT INTO authority.scope_instance (id,run_id,scope_key,input,local_state) VALUES ($1,'run',$2,$3,$3)", [id, `scope_${index}`, JSON.stringify(value)]);
    for (const [index, pool_key] of [...new Set(pool_keys)].entries()) await db.query("INSERT INTO authority.capacity_pool (id,run_id,pool_key,capacity) VALUES ($1,'run',$2,1)", [`pool_${index}`, pool_key]);
    const requests: { request: CommitRequest; source: NonNullable<Awaited<ReturnType<typeof readSnapshot>>> }[] = [];
    for (const [index, id] of ["one", "two"].entries()) {
      const source = (await readSnapshot(db, id as ScopeId, { id, key: "start", payload: value }))!;
      const pool_key = pool_keys[index]!;
      const pool_id = source.pools.find((pool) => pool.pool_key === pool_key)!.id;
      requests.push({ source, request: {
        identity: { run_id: "run" as RunId, scope_id: id as ScopeId, ingress_id: id, request_digest: id }, read_set: source.read_set, operator_version: null,
        decision: { kind: "apply", explanation: { bundle_digest: "digest", node_id: "n", owner: id, read_set: [], trace: [], trigger_id: id }, mutations: [{ kind: "acquire", pool: pool_key }], invocations: [], targets: [] },
        capacity: [{ kind: "acquire", pool_id: pool_id as PoolId, scope_id: id as ScopeId }], outputs: [], effects: [],
      } });
    }
    const outcomes = await Promise.all(requests.map(({ request, source }) => commitDecision(db, request, source)));
    const active = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.capacity_reservation WHERE is_active", []);
    return { committed: outcomes.filter((result) => result.ok && result.value.kind === "Committed").length, active: Number(active[0]?.count ?? 0) };
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
}

test("concurrent acquisitions never overbook a one-slot pool", async () => {
  expect(await runCapacityCase(["workers", "workers"])).toEqual({ committed: 1, active: 1 });
});

test("sibling scopes in one run can reserve different pools from the same snapshot", async () => {
  expect(await runCapacityCase(["analysis", "implementation"])).toEqual({ committed: 2, active: 2 });
});
