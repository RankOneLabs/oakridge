import { afterAll, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { applyMigrations, migrationNames } from "../src/storage/migrate";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { createScratchDatabase, type ScratchDatabase } from "./support/durable-database";

const scratches: ScratchDatabase[] = [];
afterAll(async () => { for (const scratch of scratches) await scratch.drop(); }, 30_000);
const active = new URL("../src/storage/migrations", import.meta.url).pathname;
const history = new URL("../src/storage/migrations-history", import.meta.url).pathname;
const names = ["0015_v15_baseline.sql", "0016_v15_worker_ownership.sql", "0017_v15_operation_execution.sql", "0018_v15_clean_cutover.sql", "0019_v15_state_consistency.sql"];
async function scratch(name: string): Promise<PgPostgresExecutor> {
  const created = await createScratchDatabase(name);
  if (!created.ok) throw new Error(created.error.detail);
  scratches.push(created.value);
  return PgPostgresExecutor.connect(created.value.url);
}

test("active migration directory contains only the replacement baseline", async () => {
  expect(migrationNames(await readdir(active))).toEqual(["0020_replacement_baseline.sql"]);
  expect(migrationNames(await readdir(history))).toEqual(names);
});

test("fresh boot creates all replacement relations and leaves old schemas absent", async () => {
  const sql = await scratch("replacement_fresh_boot");
  try {
    expect(await applyMigrations(sql)).toEqual(["0020_replacement_baseline.sql"]);
    expect(await applyMigrations(sql)).toEqual([]);
    const tables = await sql.query<{ readonly table_name: string }>(`SELECT table_name FROM information_schema.tables
      WHERE table_schema='oakridge_replacement' ORDER BY table_name`, []);
    expect(tables.map((row) => row.table_name)).toEqual([
      "artifact_revision", "capacity_pool", "capacity_reservation", "child_collection", "definition_bundle",
      "effect_intent", "execution", "execution_selection", "fact", "ingress_receipt", "output_slot",
      "resource_binding", "run", "scope_export", "scope_instance", "transition",
    ]);
    expect(await sql.query("SELECT to_regnamespace('oakridge') AS legacy, to_regnamespace('dev_flow') AS adapter", []))
      .toEqual([{ legacy: null, adapter: null }]);
  } finally { await sql.close(); }
}, 60_000);

test("v15 lineage cutover applies 0020 without altering the retained schemas", async () => {
  const sql = await scratch("replacement_v15_cutover");
  try {
    expect(await applyMigrations(sql, history)).toEqual(names);
    const before = await sql.query<{ readonly tables: string }>(`SELECT count(*)::text AS tables FROM information_schema.tables
      WHERE table_schema IN ('oakridge','dev_flow')`, []);
    expect(await applyMigrations(sql)).toEqual(["0020_replacement_baseline.sql"]);
    expect(await applyMigrations(sql)).toEqual([]);
    const after = await sql.query<{ readonly tables: string }>(`SELECT count(*)::text AS tables FROM information_schema.tables
      WHERE table_schema IN ('oakridge','dev_flow')`, []);
    expect(after).toEqual(before);
    expect((await sql.query<{ readonly name: string }>("SELECT name FROM public.oakridge_schema_migration ORDER BY name", []))
      .map((row) => row.name)).toEqual([...names, "0020_replacement_baseline.sql"]);
  } finally { await sql.close(); }
}, 60_000);

test("concurrent first boots apply the baseline once", async () => {
  const created = await createScratchDatabase("replacement_concurrent_boot");
  if (!created.ok) throw new Error(created.error.detail);
  scratches.push(created.value);
  const left = PgPostgresExecutor.connect(created.value.url);
  const right = PgPostgresExecutor.connect(created.value.url);
  try {
    const results = await Promise.all([applyMigrations(left), applyMigrations(right)]);
    expect(results.map((value) => value.length).sort()).toEqual([0, 1]);
  } finally { await left.close(); await right.close(); }
}, 60_000);
