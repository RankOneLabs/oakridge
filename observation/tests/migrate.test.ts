import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "pg";
import { sql } from "kysely";
import { openDatabase } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { readdir } from "node:fs/promises";
import historicalCatalog from "./fixtures/preconsolidation-catalog.json";
import { dropScratchDatabase } from "./database-fixture";

const serverUrl = process.env.OAKRIDGE_TEST_DATABASE_URL;
const integration = serverUrl ? test : test.skip;

async function scratch(work: (url: string) => Promise<void>): Promise<void> {
  if (!serverUrl) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required");
  const name = `observation_test_${randomBytes(6).toString("hex")}`;
  const admin = new Client({ connectionString: serverUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(serverUrl);
    url.pathname = `/${name}`;
    try { await work(url.href); }
    finally { await dropScratchDatabase(admin, name); }
  } finally { await admin.end(); }
}


integration("fresh schema has local grading tables and repeats without applying upgrades", async () => scratch(async (url) => {
  const db = openDatabase(url);
  try {
    await migrateEmptyDatabase(db);
    await migrateEmptyDatabase(db);
    const result = await sql<{ jobs: string | null; attempts: string | null; forbidden: number; baselines: number }>`SELECT
      to_regclass('observation.grading_job')::text AS jobs,
      to_regclass('observation.grading_provider_attempt')::text AS attempts,
      (SELECT count(*)::integer FROM pg_tables WHERE schemaname = 'observation' AND tablename LIKE 'langfuse%') AS forbidden,
      (SELECT count(*)::integer FROM observation.schema_baseline) AS baselines`.execute(db);
    expect(result.rows[0]).toEqual({ jobs: "observation.grading_job", attempts: "observation.grading_provider_attempt", forbidden: 0, baselines: 1 });
  } finally { await db.destroy(); }
}));

integration("an incompatible schema is refused instead of adopted", async () => scratch(async (url) => {
  const db = openDatabase(url);
  try {
    await migrateEmptyDatabase(db);
    await sql`UPDATE observation.schema_baseline SET digest = ${"0".repeat(64)}`.execute(db);
    await expect(migrateEmptyDatabase(db)).rejects.toThrow("baseline digest mismatch");
  } finally { await db.destroy(); }
}));

// Captured from the thirteen-file sequence at 01c8b605, before consolidation.
// Column ordinals are deliberately absent: moving ADD COLUMN into CREATE TABLE
// changes ordinals without changing the schema contract.
interface CatalogEntry { readonly kind: string; readonly table_name: string; readonly name: string; readonly definition: string }
const compareCatalogEntries = (left: CatalogEntry, right: CatalogEntry): number =>
  left.kind.localeCompare(right.kind) || left.table_name.localeCompare(right.table_name) || left.name.localeCompare(right.name);

integration("the single baseline preserves the historical catalog except for capture provenance", async () => scratch(async (url) => {
  const db = openDatabase(url);
  try {
    await migrateEmptyDatabase(db);
    const catalog = await sql.raw<CatalogEntry>(`SELECT 'table' AS kind, c.relname AS table_name, c.relname AS name, '' AS definition
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='observation' AND c.relkind='r'
UNION ALL
SELECT 'column', c.relname, a.attname, format_type(a.atttypid,a.atttypmod) || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE ' NULL' END || ' DEFAULT ' || coalesce(pg_get_expr(d.adbin,d.adrelid),'') || ' GENERATED ' || a.attgenerated::text
FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname='observation' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
UNION ALL
SELECT 'constraint', c.relname, con.conname, pg_get_constraintdef(con.oid) FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='observation'
UNION ALL
SELECT 'index', t.relname, i.relname, pg_get_indexdef(i.oid) FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_class t ON t.oid=x.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='observation'
UNION ALL
SELECT 'trigger', c.relname, t.tgname, pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='observation' AND NOT t.tgisinternal
ORDER BY kind,table_name,name`).execute(db);
    const retiredColumns = ["definition", "bundle"].join("_");
    const expected = historicalCatalog.filter((entry) => !(entry.kind === "column" && entry.table_name === "source_revision"
      && [retiredColumns + "_id", retiredColumns + "_digest"].includes(entry.name)));
    expected.push({ kind: "column", table_name: "source_revision", name: "definition_id", definition: "text NOT NULL DEFAULT  GENERATED " });
    expect(catalog.rows.sort(compareCatalogEntries)).toEqual(expected.sort(compareCatalogEntries));
  } finally { await db.destroy(); }
}));

test("only the consolidated observation SQL baseline is committed", async () => {
  const names = await readdir(new URL("../src/storage/migrations", import.meta.url));
  expect(names.filter((name) => name.endsWith(".sql"))).toEqual(["0001_observation.sql"]);
});

integration("the recorded digest is the SHA-256 of the whole baseline text", async () => scratch(async (url) => {
  const db = openDatabase(url);
  try {
    await migrateEmptyDatabase(db);
    const baseline = await Bun.file(new URL("../src/storage/migrations/0001_observation.sql", import.meta.url)).text();
    const recorded = await db.selectFrom("observation.schema_baseline").select("digest").execute();
    expect(recorded).toEqual([{ digest: createHash("sha256").update(baseline).digest("hex") }]);
  } finally { await db.destroy(); }
}));

integration("a nonempty database is refused before applying any baseline DDL", async () => scratch(async (url) => {
  const db = openDatabase(url);
  try {
    await sql`CREATE TABLE public.stray (id integer)`.execute(db);
    await expect(migrateEmptyDatabase(db)).rejects.toThrow("observation baseline requires an empty database");
    const schema = await sql<{ name: string | null }>`SELECT to_regnamespace('observation')::text AS name`.execute(db);
    expect(schema.rows).toEqual([{ name: null }]);
  } finally { await db.destroy(); }
}));

integration("PostgreSQL versions below 15 are refused before DDL", async () => scratch(async (url) => {
  const db = openDatabase(url);
  // Emulate the older server's version response at the database IO boundary.
  const olderServer = db.withPlugin({ transformQuery: ({ node }) => node,
    transformResult: async ({ result }) => ({ ...result, rows: [{ server_version_num: "140000" }] }) });
  try {
    await expect(migrateEmptyDatabase(olderServer)).rejects.toThrow("PostgreSQL 15+ is required for the observation baseline");
    const schema = await sql<{ name: string | null }>`SELECT to_regnamespace('observation')::text AS name`.execute(db);
    expect(schema.rows).toEqual([{ name: null }]);
  } finally { await db.destroy(); }
}));
