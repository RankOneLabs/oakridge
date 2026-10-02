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
  const retired = ["0016_dev_flow_pull_requests.sql", "0017_artifact_threads_and_attempt_idempotency.sql"]
    .filter((name) => appliedNames.has(name));
  if (retired.length > 0) throw new Error(
    `oakridge migration ledger records retired migrations ${retired.join(", ")}; drop and recreate this v15 database`);
  const pending = migrationNames(await readdir(directory)).filter((name) => !appliedNames.has(name));
  for (const name of pending) {
    const statement = await readFile(join(directory, name), "utf8");
    await sql.transaction(async (transaction) => {
      await transaction.query(statement, []);
      await transaction.query("INSERT INTO public.oakridge_schema_migration (name, applied_at) VALUES ($1, now())", [name]);
    });
  }
  if (appliedNames.has("0015_v15_baseline.sql")) {
    // Compare the contract required by the edited baseline, including nullability.
    interface SchemaRequirement { readonly table_name: string; readonly column_name: string | null; readonly nullable?: boolean }
    interface SchemaColumn { readonly table_name: string; readonly column_name: string; readonly is_nullable: string }
    const requirements: readonly SchemaRequirement[] = [
      { table_name: "artifact_thread", column_name: null },
      { table_name: "attempt", column_name: "idempotency_key" },
      { table_name: "dev_flow_build_cohort", column_name: null },
      ...["state", "round", "depends_on"].map((column_name) => ({ table_name: "cohort", column_name })),
      ...["cohort_id", "round", "output_name", "collection_key", "artifact_id", "recorded_at"]
        .map((column_name) => ({ table_name: "cohort_output", column_name })),
      ...["event", "from_state", "to_state", "effects_started_at"]
        .map((column_name) => ({ table_name: "run_transition", column_name })),
      { table_name: "attempt", column_name: "request", nullable: true },
    ];
    const columns = await sql.query<SchemaColumn>(
      "SELECT table_name,column_name,is_nullable FROM information_schema.columns WHERE table_schema='oakridge'", []);
    const missing = requirements.filter((requirement) => !columns.some((column) =>
      column.table_name === requirement.table_name
      && (requirement.column_name === null || column.column_name === requirement.column_name)
      && (requirement.nullable !== true || column.is_nullable === "YES")))
      .map((requirement) => `${requirement.table_name}${requirement.column_name ? `.${requirement.column_name}` : ""}${requirement.nullable ? " (nullable)" : ""}`);
    if (missing.length > 0) throw new Error(
      `oakridge migration ledger records 0015_v15_baseline.sql but schema diverges: missing ${missing.join(", ")}; drop and recreate this v15 database`);
  }
  return pending;
};
