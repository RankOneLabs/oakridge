import { resolve } from "node:path";
import { CoreClient } from "../src/core-client/client";
import { expect, test } from "bun:test";
import { Pool } from "pg";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { readSnapshot, hasSameReadSet } from "../src/storage/snapshot-reader";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import type { ScopeId } from "../src/storage/schema-records";
import type { CheckedValue, DefinitionBundle } from "../src/core-client/generated-contracts";

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
    const bundle: DefinitionBundle = await Bun.file(resolve(import.meta.dir, "../../workflow-core/fixtures/bundles/children-1.json")).json();
    await db.query("INSERT INTO authority.definition_bundle (id,digest,source,checked_program) VALUES ('bundle','digest',$1,'{}')", [JSON.stringify(bundle)]);
    await db.query("INSERT INTO authority.run (id,definition_bundle_id) VALUES ('run','bundle')", []);
    const state: CheckedValue = { schema: "position", data: { kind: "variant", variant: "waiting", value } };
    await db.query("INSERT INTO authority.scope_instance (id,run_id,scope_key,input,local_state) VALUES ('scope','run','batch',$1,$2)", [JSON.stringify(value), JSON.stringify(state)]);
    await db.query("INSERT INTO authority.scope_instance (id,run_id,parent_id,child_key,scope_key,input,local_state) VALUES ('child','run','scope','item_0','document',$1,$2)", [JSON.stringify(value), JSON.stringify(state)]);
    await db.query("INSERT INTO authority.child_collection (id,scope_id,collection_key) VALUES ('members','scope','items')", []);
    await db.query("INSERT INTO authority.capacity_pool (id,run_id,pool_key,capacity) VALUES ('pool','run','workers',1)", []);
    await db.query("INSERT INTO authority.scope_export (id,scope_id,export_key,value) VALUES ('export','child','released',$1)", [JSON.stringify({ schema: "flag", data: { kind: "boolean", value: true } })]);
    await db.query("INSERT INTO authority.resource_binding (id,scope_id,resource_key,observation) VALUES ('resource','scope','source',$1)", [JSON.stringify({ schema: "resource", data: { kind: "reference", brand: "resource", id: "repo" } })]);
    await db.query("INSERT INTO authority.resource_binding (id,scope_id,resource_key,observation) VALUES ('private-resource','child','source',$1)", [JSON.stringify(value)]);
    await db.query("INSERT INTO authority.scope_export (id,scope_id,export_key,value) VALUES ('private-export','child','private',$1), ('own-export','scope','released',$1)", [JSON.stringify(value)]);
    await db.query("INSERT INTO authority.artifact_revision (id,scope_id,output_key,body) VALUES ('private-revision','child','document',$1)", [JSON.stringify(value)]);
    await db.query("INSERT INTO authority.output_slot (id,scope_id,output_key,current_revision_id) VALUES ('private-slot','child','document','private-revision')", []);
    const trigger = { id: "event", key: "publish", payload: value };
    const source = await readSnapshot(db, "scope" as ScopeId, trigger);
    expect(source?.read_set.membership).toHaveLength(9);
    expect(source?.snapshot.observations.map((item) => item.root.kind)).toEqual(["child", "resource"]);
    expect(source?.snapshot.observations[0]?.root).toEqual({ kind: "child", key: "item_0", export: "released" });
    const core = CoreClient.start({ binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), deadlineMs: 10_000 });
    if (!core.ok) throw new Error("workflow-cli did not start");
    try {
      const evaluated = await core.value.request("evaluate", { bundle, available_operations: bundle.operations, snapshot: source!.snapshot });
      expect(evaluated).toMatchObject({ ok: true, value: { kind: "evaluated", value: { kind: "apply", outcome: { schema: "result", data: { kind: "variant", variant: "released" } } } } });
    } finally { core.value.close(); }
    await db.query("UPDATE authority.child_collection SET version=version+1 WHERE id='members'", []);
    expect(await db.transaction((tx) => hasSameReadSet(tx, source!.read_set))).toBe(false);
    await db.query("INSERT INTO authority.child_collection (id,scope_id,collection_key,version) VALUES ('a','scope','first',0), ('b','scope','second',1)", []);
    const before_membership_change = (await readSnapshot(db, "scope" as ScopeId, trigger))!;
    await db.query("DELETE FROM authority.child_collection WHERE id IN ('a','b')", []);
    await db.query("INSERT INTO authority.child_collection (id,scope_id,collection_key,version) VALUES ('a:0|b','scope','replacement',1)", []);
    expect(await db.transaction((tx) => hasSameReadSet(tx, before_membership_change.read_set))).toBe(false);
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
});
