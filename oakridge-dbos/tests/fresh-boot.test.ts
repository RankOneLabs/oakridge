import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { Pool } from "pg";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { createProductionComposition } from "../src/runtime/compose";

test("empty database cold boots, compiles through workflow-cli and serves a run projection", async () => {
  const admin_url = process.env.OAKRIDGE_TEST_DATABASE_URL;
  if (!admin_url) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required for the cold boot integration test");
  const name = `boot_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: admin_url });
  const url = new URL(admin_url); url.pathname = `/${name}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const db = PgPostgresExecutor.connect(url.href);
  let composition: ReturnType<typeof createProductionComposition> | null = null;
  try {
    await migrateEmptyDatabase(db);
    composition = createProductionComposition({ database_url: url.href, core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), host: "127.0.0.1" });
    const bundle = await Bun.file(resolve(import.meta.dir, "../../workflow-core/fixtures/bundles/minimal.json")).json();
    const created = await composition.app.request("http://localhost/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bundle) });
    expect(created.status).toBe(201);
    const run: { run_id: string; root_scope_id: string } = await created.json();
    const projection = await composition.app.request(`http://localhost/runs/${run.run_id}`);
    expect(projection.status).toBe(200);
    expect(await projection.json()).toMatchObject({ run_id: run.run_id, root_scope_id: run.root_scope_id, scope_key: bundle.root, version: 0 });
  } finally {
    if (composition) await composition.close();
    await db.close();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
});
