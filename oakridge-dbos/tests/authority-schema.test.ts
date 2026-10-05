import { expect, test } from "bun:test";
import { Pool } from "pg";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { PgPostgresExecutor } from "../src/storage/sql-executor";

test("baseline creates all sixteen authority relations and refuses a second application", async () => {
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
    expect(tables.map((row) => row.table_name)).toEqual(["artifact_revision", "capacity_pool", "capacity_reservation", "child_collection", "definition_bundle", "effect_intent", "execution", "execution_selection", "fact", "ingress_receipt", "output_slot", "resource_binding", "run", "scope_export", "scope_instance", "transition"]);
    await expect(migrateEmptyDatabase(db)).rejects.toThrow("requires an empty database");
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
});
