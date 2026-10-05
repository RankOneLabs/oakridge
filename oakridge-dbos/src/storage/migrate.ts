import { PgPostgresExecutor, type TransactionalSqlExecutor } from "./sql-executor";

const migration = new URL("./migrations/0001_core_authority.sql", import.meta.url);

export async function migrateEmptyDatabase(db: TransactionalSqlExecutor): Promise<void> {
  const existing = await db.query<{ table_name: string }>(
    "SELECT table_schema || '.' || table_name AS table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_type = 'BASE TABLE' LIMIT 1", []);
  if (existing.length) throw new Error(`authority baseline requires an empty database; found ${existing[0]!.table_name}`);
  const sql = await Bun.file(migration).text();
  await db.transaction(async (transaction) => { await transaction.query(sql, []); });
}

if (import.meta.main) {
  const url = process.env.DBOS_SYSTEM_DATABASE_URL;
  if (!url) throw new Error("DBOS_SYSTEM_DATABASE_URL is required for the empty-database baseline");
  const db = PgPostgresExecutor.connect(url);
  try { await migrateEmptyDatabase(db); }
  finally { await db.close(); }
}
