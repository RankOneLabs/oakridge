import { expect, test } from "bun:test";
import { Pool } from "pg";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { readSnapshot, hasSameReadSet } from "../src/storage/snapshot-reader";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import type { ScopeId } from "../src/storage/schema-records";
import type { CheckedValue } from "../src/core-client/generated-contracts";

test("snapshot records output, export, resource, collection and capacity membership versions", async () => {
  const admin_url = process.env.OAKRIDGE_TEST_DATABASE_URL;
  if (!admin_url) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required for the PostgreSQL snapshot integration test");
  const name = `snapshot_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: admin_url });
  const test_url = new URL(admin_url); test_url.pathname = `/${name}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const db = PgPostgresExecutor.connect(test_url.href);
  const value: CheckedValue = { schema: "unit", data: { kind: "record", fields: [], dictionary: [] } };
  try {
    await migrateEmptyDatabase(db);
    await db.query("INSERT INTO authority.definition_bundle (id,digest,source,checked_program) VALUES ('bundle','digest','{}','{}')", []);
    await db.query("INSERT INTO authority.run (id,definition_bundle_id) VALUES ('run','bundle')", []);
    await db.query("INSERT INTO authority.scope_instance (id,run_id,scope_key,input,local_state) VALUES ('scope','run','root',$1,$1)", [JSON.stringify(value)]);
    await db.query("INSERT INTO authority.child_collection (id,scope_id,collection_key) VALUES ('members','scope','items')", []);
    await db.query("INSERT INTO authority.capacity_pool (id,run_id,pool_key,capacity) VALUES ('pool','run','workers',1)", []);
    await db.query("INSERT INTO authority.scope_export (id,scope_id,export_key,value) VALUES ('export','scope','result',$1)", [JSON.stringify(value)]);
    await db.query("INSERT INTO authority.resource_binding (id,scope_id,resource_key,observation) VALUES ('resource','scope','repo',$1)", [JSON.stringify(value)]);
    const trigger = { id: "event", key: "start", payload: value };
    const source = await readSnapshot(db, "scope" as ScopeId, trigger);
    expect(source?.read_set.membership).toHaveLength(9);
    expect(source?.snapshot.observations.map((item) => item.root.kind)).toEqual(["child", "resource"]);
    await db.query("UPDATE authority.child_collection SET version=version+1 WHERE id='members'", []);
    expect(await db.transaction((tx) => hasSameReadSet(tx, source!.read_set))).toBe(false);
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
});
