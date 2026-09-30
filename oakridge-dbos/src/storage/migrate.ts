import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { TransactionalSqlExecutor } from "./sql-executor";

const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;

export const migrationNames = (entries: readonly string[]): readonly string[] =>
  entries.filter((entry) => MIGRATION_NAME.test(entry)).sort();

export const applyMigrations = async (sql: TransactionalSqlExecutor, directory = join(import.meta.dir, "migrations")): Promise<readonly string[]> => {
  await sql.query(`CREATE TABLE IF NOT EXISTS public.oakridge_schema_migration
    (name text PRIMARY KEY, applied_at timestamptz NOT NULL)`, []);
  const applied = await sql.query<{ readonly name: string }>("SELECT name FROM public.oakridge_schema_migration", []);
  const appliedNames = new Set(applied.map((row) => row.name));
  const pending = migrationNames(await readdir(directory)).filter((name) => !appliedNames.has(name));
  for (const name of pending) {
    const statement = await readFile(join(directory, name), "utf8");
    await sql.transaction(async (transaction) => {
      await transaction.query(statement, []);
      await transaction.query("INSERT INTO public.oakridge_schema_migration (name, applied_at) VALUES ($1, now())", [name]);
    });
  }
  if (appliedNames.has("0015_v15_baseline.sql")) {
    const rows = await sql.query<{ readonly artifact_thread: string | null;
      readonly dev_flow_build_cohort: string | null; readonly attempt_idempotency_key: boolean }>(
      `SELECT to_regclass('oakridge.artifact_thread')::text AS artifact_thread,
        to_regclass('oakridge.dev_flow_build_cohort')::text AS dev_flow_build_cohort,
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='oakridge'
          AND table_name='attempt' AND column_name='idempotency_key') AS attempt_idempotency_key`, []);
    const schema = rows[0];
    const missing = [
      schema?.artifact_thread ? null : "artifact_thread",
      schema?.attempt_idempotency_key ? null : "attempt.idempotency_key",
      schema?.dev_flow_build_cohort ? null : "dev_flow_build_cohort",
    ].filter((name): name is string => name !== null);
    if (missing.length > 0) throw new Error(
      `oakridge migration ledger records 0015_v15_baseline.sql but schema diverges: missing ${missing.join(", ")}; drop and recreate this v15 database`);
  }
  return pending;
};
