import { expect, test } from "bun:test";
import { Pool } from "pg";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { readSnapshot } from "../src/storage/snapshot-reader";
import { commitDecision, type CommitRequest } from "../src/storage/commit";
import type { CheckedValue } from "../src/core-client/generated-contracts";
import type { PoolId, RunId, ScopeId } from "../src/storage/schema-records";

test("a fault after state, output and reservation writes rolls the entire decision back", async () => {
  const admin_url = process.env.OAKRIDGE_TEST_DATABASE_URL;
  if (!admin_url) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required for PostgreSQL commit tests");
  const name = `atomic_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: admin_url });
  const url = new URL(admin_url); url.pathname = `/${name}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const db = PgPostgresExecutor.connect(url.href);
  const value: CheckedValue = { schema: "unit", data: { kind: "record", fields: [], dictionary: [] } };
  try {
    await migrateEmptyDatabase(db);
    await db.query("INSERT INTO authority.definition_bundle (id,digest,source,checked_program) VALUES ('bundle','digest',$1,'{}')", [JSON.stringify({ scopes: [{ key: "root", outputs: [{ key: "report", producers: [] }] }] })]);
    await db.query("INSERT INTO authority.run (id,definition_bundle_id) VALUES ('run','bundle')", []);
    await db.query("INSERT INTO authority.scope_instance (id,run_id,scope_key,input,local_state) VALUES ('scope','run','root',$1,$1)", [JSON.stringify(value)]);
    await db.query("INSERT INTO authority.capacity_pool (id,run_id,pool_key,capacity) VALUES ('pool','run','workers',1)", []);
    const trigger = { id: "t", key: "start", payload: value };
    const source = (await readSnapshot(db, "scope" as ScopeId, trigger))!;
    const request: CommitRequest = {
      identity: { run_id: "run" as RunId, scope_id: "scope" as ScopeId, ingress_id: "i", request_digest: "digest" },
      read_set: source.read_set, operator_version: null,
      decision: { kind: "apply", explanation: { bundle_digest: "digest", node_id: "n", owner: "scope", read_set: [], trace: [], trigger_id: "t" }, mutations: [{ kind: "set_state", value }, { kind: "acquire", pool: "workers" }], invocations: [], targets: [] },
      outputs: [{ scope_id: "scope" as ScopeId, output_key: "report", collection_key: "", body: value, predecessor_id: null, expected_slot_version: null, execution_id: null }],
      capacity: [{ kind: "acquire", pool_id: "pool" as PoolId, scope_id: "scope" as ScopeId }],
      effects: [{ effect_key: "same", payload: value, execution_id: null }, { effect_key: "same", payload: value, execution_id: null }],
    };
    const result = await commitDecision(db, request, source);
    expect(result.ok).toBe(false);
    const rows = await db.query<{ state_version: string; receipt_count: string; output_count: string; reservation_count: string; effect_count: string }>("SELECT (SELECT version::text FROM authority.scope_instance WHERE id='scope') AS state_version, (SELECT count(*)::text FROM authority.ingress_receipt) AS receipt_count, (SELECT count(*)::text FROM authority.output_slot) AS output_count, (SELECT count(*)::text FROM authority.capacity_reservation) AS reservation_count, (SELECT count(*)::text FROM authority.effect_intent) AS effect_count", []);
    expect(rows[0]).toEqual({ state_version: "0", receipt_count: "0", output_count: "0", reservation_count: "0", effect_count: "0" });
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
});
