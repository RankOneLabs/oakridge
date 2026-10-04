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
  if (!appliedNames.has("0015_v15_baseline.sql")) {
    const existing = await sql.query<{ readonly schema_name: string }>(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name='oakridge'", []);
    if (existing.length > 0) throw new Error(
      "oakridge database predates the v15 baseline; stop writers, back up the database, and recreate it using docs/v15-cutover.md");
  }
  const retired = ["0016_dev_flow_pull_requests.sql", "0017_artifact_threads_and_attempt_idempotency.sql"]
    .filter((name) => appliedNames.has(name));
  if (retired.length > 0) throw new Error(
    `oakridge migration ledger records retired migrations ${retired.join(", ")}; drop and recreate this v15 database`);
  if (appliedNames.has("0015_v15_baseline.sql")) {
    // Retained ledger requirements remain checked after worker ownership applies.
    interface SchemaRequirement { readonly table_schema: "oakridge" | "dev_flow"; readonly table_name: string; readonly column_name: string | null; readonly nullable?: boolean }
    interface SchemaColumn { readonly table_schema: string; readonly table_name: string; readonly column_name: string; readonly is_nullable: string }
    const requirements: readonly SchemaRequirement[] = [
      { table_schema: "oakridge", table_name: "artifact_thread", column_name: null },
      { table_schema: "oakridge", table_name: "attempt", column_name: "idempotency_key" },
      ...(appliedNames.has("0018_v15_clean_cutover.sql") ? [] : [
        { table_schema: "dev_flow" as const, table_name: "build_cohort", column_name: null },
      ]),
      ...["state", "depends_on"].map((column_name): SchemaRequirement => ({ table_schema: "oakridge", table_name: "cohort", column_name })),

      ...["event", "from_state", "to_state", "effects_started_at"]
        .map((column_name): SchemaRequirement => ({ table_schema: "oakridge", table_name: "run_transition", column_name })),
      { table_schema: "oakridge", table_name: "attempt", column_name: "request", nullable: true },
    ];
    const retiredRequirements: readonly SchemaRequirement[] = appliedNames.has("0016_v15_worker_ownership.sql") ? [] : [
      { table_schema: "oakridge", table_name: "cohort", column_name: "round" },
      ...["cohort_id", "round", "output_name", "collection_key", "artifact_id", "recorded_at"]
        .map((column_name): SchemaRequirement => ({ table_schema: "oakridge", table_name: "cohort_output", column_name })),
    ];
    const columns = await sql.query<SchemaColumn>(
      "SELECT table_schema,table_name,column_name,is_nullable FROM information_schema.columns WHERE table_schema IN ('oakridge','dev_flow')", []);
    const missing = [...requirements, ...retiredRequirements].filter((requirement) => !columns.some((column) =>
      column.table_schema === requirement.table_schema && column.table_name === requirement.table_name
      && (requirement.column_name === null || column.column_name === requirement.column_name)
      && (requirement.nullable !== true || column.is_nullable === "YES")))
      .map((requirement) => `${requirement.table_name}${requirement.column_name ? `.${requirement.column_name}` : ""}${requirement.nullable ? " (nullable)" : ""}`);
    if (missing.length > 0) throw new Error(
      `oakridge migration ledger records 0015_v15_baseline.sql but schema diverges: missing ${missing.join(", ")}; drop and recreate this v15 database`);
  }
  if (appliedNames.has("0016_v15_worker_ownership.sql")) {
    const columns = await sql.query<{ readonly table_name: string; readonly column_name: string; readonly is_nullable: string }>(
      "SELECT table_name,column_name,is_nullable FROM information_schema.columns WHERE table_schema='oakridge'", []);
    const required = [
      { table_name: "attempt", column_name: "worker" },
      { table_name: "cohort", column_name: "frozen_inputs" },
      { table_name: "cohort_worker", column_name: "active_execution_id" },
      { table_name: "worker_output", column_name: "acceptance_state" },
      { table_name: "cohort_request_receipt", column_name: "request_id" },
      { table_name: "execution_intent", column_name: "resolved_input" },
    ];
    const missing = required.filter((item) => !columns.some((column) => column.table_name === item.table_name && column.column_name === item.column_name));
    if (missing.length) throw new Error(`0016_v15_worker_ownership.sql schema diverges: missing ${missing.map((item) => `${item.table_name}.${item.column_name}`).join(", ")}`);
    if (columns.some((column) => column.table_name === "cohort_output" || column.table_name === "artifact_acceptance"
      || column.table_name === "cohort" && ["round", "stage_data"].includes(column.column_name)))
      throw new Error("0016 worker ownership schema retains retired cohort acceptance or input storage");
  }
  if (appliedNames.has("0017_v15_operation_execution.sql")) {
    const columns = await sql.query<{ readonly table_name: string; readonly column_name: string; readonly is_nullable: string }>(
      "SELECT table_name,column_name,is_nullable FROM information_schema.columns WHERE table_schema='oakridge'", []);
    const required = [
      { table_name: "execution_intent", column_name: "operation" },
      { table_name: "execution_intent", column_name: "operation_outcome" },
      { table_name: "stage_instance", column_name: "initialized_at" },
      { table_name: "cohort", column_name: "materialization_position" },
      { table_name: "artifact", column_name: "acceptance_state" },
    ];
    const missing = required.filter((item) => !columns.some((column) => column.table_name === item.table_name && column.column_name === item.column_name));
    if (missing.length || ["prompt", "settings"].some((name) => !columns.some((column) => column.table_name === "execution_intent" && column.column_name === name && column.is_nullable === "YES")))
      throw new Error("0017_v15_operation_execution.sql schema diverges from session-free operation ownership");
  }
  if (appliedNames.has("0018_v15_clean_cutover.sql")) {
    interface CutoverColumn { readonly table_schema: string; readonly table_name: string; readonly column_name: string }
    const columns = await sql.query<CutoverColumn>(
      "SELECT table_schema,table_name,column_name FROM information_schema.columns WHERE table_schema IN ('oakridge','dev_flow')", []);
    const required = ["repository_head_sha", "pending_repository_head_sha", "current_verified_pull_request_id"];
    if (required.some((name) => !columns.some((column) => column.table_schema === "oakridge" && column.table_name === "cohort" && column.column_name === name))
      || !columns.some((column) => column.table_schema === "oakridge" && column.table_name === "prompt_bundle" && column.column_name === "entries")
      || columns.some((column) => column.table_schema === "dev_flow" && column.table_name === "build_cohort"
        || column.table_schema === "oakridge" && column.table_name === "prompt_bundle" && column.column_name === "matrix"))
      throw new Error("0018_v15_clean_cutover.sql schema diverges from cohort ownership and action-point prompt entries");
  }
  const pending = migrationNames(await readdir(directory)).filter((name) => !appliedNames.has(name));
  for (const name of pending) {
    const statement = await readFile(join(directory, name), "utf8");
    await sql.transaction(async (transaction) => {
      await transaction.query(statement, []);
      await transaction.query("INSERT INTO public.oakridge_schema_migration (name, applied_at) VALUES ($1, now())", [name]);
    });
  }
  return pending;
};
