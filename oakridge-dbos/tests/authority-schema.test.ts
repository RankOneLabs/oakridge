import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { PgPostgresExecutor } from "../src/storage/sql-executor";

test("fresh v2 baseline supports two roots and run-scoped ingress", async () => {
  const admin_url = process.env.OAKRIDGE_TEST_DATABASE_URL;
  if (!admin_url) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required");
  const name = `authority_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: admin_url });
  const test_url = new URL(admin_url);
  test_url.pathname = `/${name}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const db = PgPostgresExecutor.connect(test_url.href);
  try {
    await migrateEmptyDatabase(db);
    await migrateEmptyDatabase(db);
    const digest = createHash("sha256").update(await Bun.file(new URL("../src/storage/migrations/0001_core.sql", import.meta.url)).text()).digest("hex");
    expect(await db.query<{ digest: string }>("SELECT digest FROM authority.schema_baseline", [])).toEqual([{ digest }]);
    const tables = await db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='authority'", []);
    for (const table of ["unit", "unit_dependency", "attempt", "artifact_revision", "review_decision", "event", "wanted_log", "effect_intent", "ingress_receipt", "capacity_reservation"])
      expect(tables.some((row) => row.table_name === table)).toBe(true);
    expect(tables.some((row) => row.table_name === "scope_instance")).toBe(false);
    const columns = await db.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema='authority' AND table_name='run'", []);
    expect(columns.some((row) => row.column_name === "current_generation" || row.column_name === "current_cursor")).toBe(false);

    await db.query("INSERT INTO authority.definition_bundle (id,digest,source,checked_program) VALUES ('bundle','digest','{}','{}')", []);
    for (const run_id of ["run1", "run2"]) {
      await db.query("INSERT INTO authority.run (id,definition_bundle_id) VALUES ($1,'bundle')", [run_id]);
      await db.query("INSERT INTO authority.unit (id,run_id,unit_key,declaration,input,status) VALUES ('run',$1,'root','root','{}','{\"kind\":\"active\"}')", [run_id]);
      await db.query("UPDATE authority.run SET root_unit_id='run' WHERE id=$1", [run_id]);
    }
    const roots = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM authority.unit WHERE parent_id IS NULL", []);
    expect(roots[0]?.count).toBe(2);
    await expect(db.query("INSERT INTO authority.unit (id,run_id,unit_key,declaration,input,status) VALUES ('duplicate','run1','root','root','{}','{}')", [])).rejects.toMatchObject({ code: "23505" });

    await db.query("INSERT INTO authority.ingress_receipt (id,run_id,unit_id,ingress_id,request_digest,result) VALUES ('receipt','run1',NULL,'launch','digest','{}')", []);
    await expect(db.query("INSERT INTO authority.ingress_receipt (id,run_id,unit_id,ingress_id,request_digest,result) VALUES ('replay','run1',NULL,'launch','digest','{}')", [])).rejects.toMatchObject({ code: "23505" });
    await db.query("INSERT INTO authority.ingress_receipt (id,run_id,unit_id,ingress_id,request_digest,result) VALUES ('other','run2',NULL,'launch','digest','{}')", []);
    await expect(db.query("INSERT INTO authority.event (id,run_id,payload) VALUES ('missing-writer','run1','{}')", [])).rejects.toMatchObject({ code: "23502" });
    await db.query("INSERT INTO authority.event (id,run_id,payload,writer) VALUES ('launch-event','run1','{\"kind\":\"launched\"}','{\"kind\":\"operator\",\"subject\":\"test\"}')", []);
    await expect(db.query("INSERT INTO authority.attempt (action_id,seq,run_id,unit_id,worker,mode,cause,status) VALUES ('a',0,'run1','missing','w','{}','{}','{}')", [])).rejects.toMatchObject({ code: "23503" });
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  }
});
