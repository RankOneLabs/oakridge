import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SqlExecutor, TransactionalSqlExecutor } from "./sql-executor";

const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;
export const migrationNames = (entries: readonly string[]): readonly string[] =>
  entries.filter((entry) => MIGRATION_NAME.test(entry)).sort();

export const applyMigrations = async (
  sql: TransactionalSqlExecutor,
  directory = join(import.meta.dir, "migrations"),
): Promise<readonly string[]> => sql.transaction(async (transaction) => {
  await transaction.query("SELECT pg_advisory_xact_lock(hashtext('oakridge_schema_migration'))", []);
  return applyMigrationsIn(transaction, directory);
});

const applyMigrationsIn = async (sql: SqlExecutor, directory: string): Promise<readonly string[]> => {
  await sql.query(`CREATE TABLE IF NOT EXISTS public.oakridge_schema_migration
    (name text PRIMARY KEY, applied_at timestamptz NOT NULL)`, []);
  const applied = await sql.query<{ readonly name: string }>("SELECT name FROM public.oakridge_schema_migration", []);
  const appliedNames = new Set(applied.map((row) => row.name));
  const pending = migrationNames(await readdir(directory)).filter((name) => !appliedNames.has(name));
  for (const name of pending) {
    await sql.query(await readFile(join(directory, name), "utf8"), []);
    await sql.query("INSERT INTO public.oakridge_schema_migration (name, applied_at) VALUES ($1, now())", [name]);
  }
  return pending;
};
