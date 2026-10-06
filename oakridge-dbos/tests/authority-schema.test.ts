import { expect, test } from "bun:test";
import { Pool } from "pg";
import { createHash } from "node:crypto";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { PgPostgresExecutor, type TransactionalSqlExecutor } from "../src/storage/sql-executor";

test("baseline creates constrained authority relations and accepts a matching second application", async () => {
  const admin_url = process.env.OAKRIDGE_TEST_DATABASE_URL;
  if (!admin_url) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required for the PostgreSQL authority integration test");
  const name = `authority_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: admin_url });
  const test_url = new URL(admin_url);
  test_url.pathname = `/${name}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const db = PgPostgresExecutor.connect(test_url.href);
  try {
    await migrateEmptyDatabase(db);
    const tables = await db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='authority' ORDER BY table_name", []);
    expect(tables.map((row) => row.table_name)).toEqual(["artifact_revision", "capacity_pool", "capacity_reservation", "child_collection", "definition_bundle", "effect_intent", "execution", "execution_selection", "fact", "ingress_receipt", "launch_receipt", "output_slot", "resource_binding", "run", "schema_baseline", "scope_export", "scope_instance", "transition"]);
    const indexes = await db.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname='authority'", []);
    for (const name of ["artifact_revision_scope_idx", "effect_intent_status_idx", "fact_scope_idx", "transition_scope_idx", "execution_selection_execution_idx", "transition_scope_created_idx", "fact_scope_key_idx"])
      expect(indexes.some((row) => row.indexname === name)).toBe(true);
    const constraints = await db.query<{ table_name: string; type: string; definition: string }>(`SELECT c.conrelid::regclass::text AS table_name,c.contype AS type,pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c WHERE c.connamespace='authority'::regnamespace`, []);
    for (const name of ["execution", "effect_intent"]) expect(constraints.some((row) => row.table_name === `authority.${name}` && row.type === "c" && row.definition.includes("status"))).toBe(true);
    for (const name of ["scope_export", "child_collection", "execution_selection", "execution", "artifact_revision", "output_slot", "fact", "transition", "ingress_receipt", "effect_intent", "capacity_reservation", "resource_binding"])
      expect(constraints.some((row) => row.table_name === `authority.${name}` && row.type === "f" && row.definition.includes("FOREIGN KEY (run_id, scope_id)"))).toBe(true);
    const digest = createHash("sha256").update(await Bun.file(new URL("../src/storage/migrations/0001_core_authority.sql", import.meta.url)).text()).digest("hex");
    expect(await db.query<{ digest: string }>("SELECT digest FROM authority.schema_baseline", [])).toEqual([{ digest }]);
    const columns = await db.query<{ table_name: string; column_name: string; is_nullable: string; column_default: string | null }>(
      "SELECT table_name,column_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema='authority'", []);
    expect(columns.some((row) => row.table_name === "artifact_revision" && row.column_name === "collection_key" && row.is_nullable === "NO" && row.column_default === "''::text")).toBe(true);
    for (const name of ["fact", "ingress_receipt"]) expect(columns.some((row) => row.table_name === name && row.column_name === "version")).toBe(false);
    expect(columns.some((row) => row.table_name === "execution" && row.column_name === "publication_secret_hash")).toBe(true);
    await db.query("INSERT INTO authority.definition_bundle (id,digest,source,checked_program) VALUES ('bundle','digest','{}','{}')", []);
    await db.query("INSERT INTO authority.run (id,definition_bundle_id) VALUES ('run','bundle')", []);
    await db.query("INSERT INTO authority.scope_instance (id,run_id,scope_key,input,local_state) VALUES ('scope','run','root','{}','{}')", []);
    await db.query("INSERT INTO authority.transition (id,scope_id,trigger_id,decision) VALUES ('first','scope','same','{}')", []);
    await expect(db.query("INSERT INTO authority.transition (id,scope_id,trigger_id,decision) VALUES ('second','scope','same','{}')", [])).rejects.toMatchObject({ code: "23505" });
    await db.query("INSERT INTO authority.run (id,definition_bundle_id) VALUES ('other-run','bundle')", []);
    await expect(db.query("INSERT INTO authority.fact (id,run_id,scope_id,fact_key,payload) VALUES ('cross-run','other-run','scope','event','{}')", [])).rejects.toMatchObject({ code: "23503" });
    await expect(db.query("INSERT INTO authority.execution (id,scope_id,worker_key,generation,status) VALUES ('bad-status','scope','worker',1,'unknown')", [])).rejects.toMatchObject({ code: "23514" });
    await expect(db.query("INSERT INTO authority.effect_intent (id,scope_id,effect_key,payload,status) VALUES ('bad-effect','scope','key','{}','unknown')", [])).rejects.toMatchObject({ code: "23514" });
    await expect(migrateEmptyDatabase(db)).resolves.toBeUndefined();
    await db.query("UPDATE authority.schema_baseline SET digest=$1", ["0".repeat(64)]);
    await expect(migrateEmptyDatabase(db)).rejects.toThrow(`recorded ${"0".repeat(64)}, current ${digest}`);
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
});

test("PostgreSQL 14 is rejected before applying the baseline", async () => {
  const db = { query: async () => [{ server_version_num: "140000" }] } as unknown as TransactionalSqlExecutor;
  await expect(migrateEmptyDatabase(db)).rejects.toThrow("PostgreSQL 15+");
});
