import { createHash, randomBytes } from "node:crypto";
import { sql } from "kysely";
import { err, ok, type Result } from "../domain/primitives";
import { openDatabase, type Database } from "./database";
import { migrations, type MigrationEntry } from "./migrations/manifest";
import { createScratchDatabase } from "../../scripts/scratch-database";

const SCHEMA = "observation";
const LOCK = "observation:baseline";
const MINIMUM_SERVER_VERSION = 150000;
interface AppliedMigration { readonly name: string; readonly digest: string; readonly applied_at: Date }
interface MigrationSource { readonly entry: MigrationEntry; readonly source: string; readonly digest: string }
interface CatalogSnapshot { readonly tables: readonly string[]; readonly columns: readonly string[]; readonly constraints: readonly string[]; readonly indexes: readonly string[] }
interface MigrationPrefixError { readonly operation: "validate_migration_prefix"; readonly entity_id: string; readonly detail: string }

async function sources(entries: readonly MigrationEntry[]): Promise<MigrationSource[]> {
  return Promise.all(entries.map(async (entry) => {
    const bytes = await Bun.file(entry.file).arrayBuffer();
    return { entry, source: new TextDecoder().decode(bytes), digest: createHash("sha256").update(new Uint8Array(bytes)).digest("hex") };
  }));
}

async function assertVersion(db: Database): Promise<void> {
  const result = await sql<{ server_version_num: string }>`SELECT current_setting('server_version_num') AS server_version_num`.execute(db);
  if (Number(result.rows[0]?.server_version_num ?? 0) < MINIMUM_SERVER_VERSION) throw new Error(`PostgreSQL 15+ is required for the ${SCHEMA} baseline`);
}

async function hasLedger(db: Database): Promise<boolean> {
  const result = await sql<{ name: string | null }>`SELECT to_regclass(${`${SCHEMA}.schema_migration`})::text AS name`.execute(db);
  return result.rows[0]?.name !== null;
}

async function assertBaseline(db: Database, baseline: MigrationSource): Promise<boolean> {
  const relation = await sql<{ name: string | null }>`SELECT to_regclass(${`${SCHEMA}.schema_baseline`})::text AS name`.execute(db);
  if (!relation.rows[0]?.name) return false;
  const recorded = await sql<{ digest: string }>`SELECT digest FROM observation.schema_baseline LIMIT 1`.execute(db);
  const digest = recorded.rows[0]?.digest;
  if (!digest) throw new Error(`${SCHEMA} baseline row is missing`);
  if (digest !== baseline.digest) throw new Error(`${SCHEMA} baseline digest mismatch for ${baseline.entry.name}: recorded ${digest}, current ${baseline.digest}`);
  return true;
}

async function assertEmpty(db: Database): Promise<void> {
  const existing = await sql<{ table_name: string }>`SELECT table_schema || '.' || table_name AS table_name FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'dbos') AND table_schema NOT LIKE 'dbos_%' AND table_type = 'BASE TABLE' LIMIT 1`.execute(db);
  if (existing.rows[0]) throw new Error(`${SCHEMA} baseline requires an empty database; found ${existing.rows[0].table_name}`);
}

async function applied(db: Database): Promise<AppliedMigration[]> {
  const result = await sql<AppliedMigration>`SELECT name, digest, applied_at FROM observation.schema_migration ORDER BY ordinal`.execute(db);
  return [...result.rows];
}

function prefixError(entity_id: string, detail: string): Result<never, MigrationPrefixError> {
  return err({ operation: "validate_migration_prefix", entity_id, detail });
}

function validatePrefix(rows: readonly AppliedMigration[], chain: readonly MigrationSource[]): Result<void, MigrationPrefixError> {
  if (rows.length > chain.length) return prefixError(SCHEMA, "ledger contains migrations missing from manifest");
  for (const [index, row] of rows.entries()) {
    const expected = chain[index];
    if (!expected || row.name !== expected.entry.name) return prefixError(row.name, `ledger order mismatch at ${row.name}`);
    if (row.digest !== expected.digest) return prefixError(row.name, `migration digest mismatch for ${row.name}: recorded ${row.digest}, current ${expected.digest}`);
  }
  return ok(undefined);
}

/** Apply the explicit migration chain, one migration and ledger row per transaction. */
export async function migrateEmptyDatabase(db: Database, entries: readonly MigrationEntry[] = migrations): Promise<void> {
  await assertVersion(db);
  const chain = await sources(entries);
  const baseline = chain[0];
  if (!baseline) throw new Error(`${SCHEMA} manifest is empty`);
  for (let index = 0; index < chain.length; index++) {
    const migration = chain[index]!;
    await db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${LOCK}, 0))`.execute(trx);
      const baselineExists = await assertBaseline(trx, baseline);
      const ledgerExists = await hasLedger(trx);
      if (!ledgerExists) {
        if (baselineExists) throw new Error(`${SCHEMA} ledger is absent; run storage:adopt on a restored copy before startup`);
        await assertEmpty(trx);
        await sql.raw(migration.source).execute(trx);
        await sql`INSERT INTO observation.schema_baseline (digest) VALUES (${migration.digest})`.execute(trx);
        await sql`CREATE TABLE observation.schema_migration (
          ordinal integer PRIMARY KEY, name text NOT NULL UNIQUE, digest text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`.execute(trx);
        await sql`INSERT INTO observation.schema_migration (ordinal, name, digest) VALUES (1, ${migration.entry.name}, ${migration.digest})`.execute(trx);
        return;
      }
      const rows = await applied(trx);
      const prefix = validatePrefix(rows, chain);
      if (!prefix.ok) throw new Error(`${SCHEMA} ${prefix.error.operation} (${prefix.error.entity_id}): ${prefix.error.detail}`);
      if (rows.length > index) return;
      if (rows.length !== index) throw new Error(`${SCHEMA} ledger is not a manifest prefix`);
      await sql.raw(migration.source).execute(trx);
      await sql`INSERT INTO observation.schema_migration (ordinal, name, digest) VALUES (${index + 1}, ${migration.entry.name}, ${migration.digest})`.execute(trx);
    });
  }
}

async function catalog(db: Database): Promise<CatalogSnapshot> {
  const tables = await sql<{ item: string }>`SELECT table_name AS item FROM information_schema.tables WHERE table_schema = ${SCHEMA} AND table_type = 'BASE TABLE' AND table_name <> 'schema_migration' ORDER BY table_name`.execute(db);
  const columns = await sql<{ item: string }>`SELECT concat_ws('|', table_name, column_name, ordinal_position, data_type, udt_name, is_nullable, column_default, generation_expression) AS item
    FROM information_schema.columns WHERE table_schema = ${SCHEMA} AND table_name <> 'schema_migration' ORDER BY table_name, ordinal_position`.execute(db);
  const constraints = await sql<{ item: string }>`SELECT c.relname || '|' || con.conname || '|' || pg_get_constraintdef(con.oid) AS item
    FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${SCHEMA} AND c.relname <> 'schema_migration' ORDER BY c.relname, con.conname`.execute(db);
  const indexes = await sql<{ item: string }>`SELECT tablename || '|' || indexname || '|' || indexdef AS item FROM pg_indexes
    WHERE schemaname = ${SCHEMA} AND tablename <> 'schema_migration' ORDER BY tablename, indexname`.execute(db);
  return { tables: tables.rows.map((row) => row.item), columns: columns.rows.map((row) => row.item),
    constraints: constraints.rows.map((row) => row.item), indexes: indexes.rows.map((row) => row.item) };
}

export function catalogDifferences(expected: CatalogSnapshot, actual: CatalogSnapshot): string[] {
  const differences: string[] = [];
  for (const category of ["tables", "columns", "constraints", "indexes"] as const) {
    const want = new Set(expected[category]);
    const have = new Set(actual[category]);
    for (const item of want) if (!have.has(item)) differences.push(`${category}: missing or changed ${item}`);
    for (const item of have) if (!want.has(item)) differences.push(`${category}: extra or changed ${item}`);
  }
  return differences;
}

/** Validate an existing fully migrated install against a scratch build, then record its history. */
export async function adoptExistingDatabase(db: Database, serverUrl: string): Promise<string[]> {
  await assertVersion(db);
  const chain = await sources(migrations);
  const baseline = chain[0]!;
  if (!(await assertBaseline(db, baseline))) throw new Error(`${SCHEMA} baseline is absent`);
  if (await hasLedger(db)) throw new Error(`${SCHEMA} ledger already exists`);
  const scratch = await createScratchDatabase(serverUrl, `observation_adopt_${randomBytes(6).toString("hex")}`);
  let differences: string[];
  try {
    const built = openDatabase(scratch.url);
    try { await migrateEmptyDatabase(built); differences = catalogDifferences(await catalog(built), await catalog(db)); }
    finally { await built.destroy(); }
  } finally { await scratch.drop(); }
  if (differences.length) throw new Error(`${SCHEMA} adoption schema difference:\n${differences.join("\n")}`);
  await db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${LOCK}, 0))`.execute(trx);
    if (await hasLedger(trx)) throw new Error(`${SCHEMA} ledger already exists`);
    await assertBaseline(trx, baseline);
    await sql`CREATE TABLE observation.schema_migration (
      ordinal integer PRIMARY KEY, name text NOT NULL UNIQUE, digest text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`.execute(trx);
    const guard = chain.find((migration) => migration.entry.name === "0006_export_guard.sql");
    if (!guard) throw new Error("observation export guard migration missing");
    await sql.raw(guard.source).execute(trx);
    for (const [index, migration] of chain.entries())
      await sql`INSERT INTO observation.schema_migration (ordinal, name, digest) VALUES (${index + 1}, ${migration.entry.name}, ${migration.digest})`.execute(trx);
  });
  return differences;
}

if (import.meta.main) {
  const url = process.env.OBSERVATION_DATABASE_URL;
  if (!url) throw new Error("OBSERVATION_DATABASE_URL is required");
  const db = openDatabase(url);
  try {
    if (process.argv.includes("--adopt")) console.log(JSON.stringify({ differences: await adoptExistingDatabase(db, url) }));
    else await migrateEmptyDatabase(db);
  } finally { await db.destroy(); }
}
