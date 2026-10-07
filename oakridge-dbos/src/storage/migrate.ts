import { PgPostgresExecutor, type TransactionalSqlExecutor } from "./sql-executor";
import { createHash } from "node:crypto";

const migration = new URL("./migrations/0001_core_authority.sql", import.meta.url);

export async function migrateEmptyDatabase(db: TransactionalSqlExecutor): Promise<void> {
  const version = await db.query<{ server_version_num: string }>("SELECT current_setting('server_version_num') AS server_version_num", []);
  if (!version[0] || Number(version[0].server_version_num) < 150000) throw new Error("PostgreSQL 15+ is required for the authority baseline");
  const sql = await Bun.file(migration).text();
  const digest = createHash("sha256").update(sql).digest("hex");
  await db.transaction(async (transaction) => {
    // Serialize the check and DDL across independently starting processes.
    await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["oakridge:authority:baseline"]);
    const relation = await transaction.query<{ name: string | null }>("SELECT to_regclass('authority.schema_baseline')::text AS name", []);
    const baseline = relation[0]?.name ? await transaction.query<{ digest: string }>("SELECT digest FROM authority.schema_baseline LIMIT 1", []) : [];
    if (baseline[0]) {
      if (baseline[0].digest !== digest) throw new Error(`authority baseline digest mismatch: recorded ${baseline[0].digest}, current ${digest}`);
      return;
    }
    const existing = await transaction.query<{ table_name: string }>(
      "SELECT table_schema || '.' || table_name AS table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'dbos') AND table_schema NOT LIKE 'dbos_%' AND table_type = 'BASE TABLE' LIMIT 1", []);
    if (existing.length) throw new Error(`authority baseline requires an empty database; found ${existing[0]!.table_name}`);
    await transaction.query(sql, []);
    await transaction.query("INSERT INTO authority.schema_baseline (digest) VALUES ($1)", [digest]);
  });
}

if (import.meta.main) {
  const url = process.env.DBOS_SYSTEM_DATABASE_URL;
  if (!url) throw new Error("DBOS_SYSTEM_DATABASE_URL is required for the empty-database baseline");
  const db = PgPostgresExecutor.connect(url);
  try { await migrateEmptyDatabase(db); }
  finally { await db.close(); }
}
