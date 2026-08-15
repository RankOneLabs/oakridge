import { applyMigrations } from "./storage/migrate";
import { PgPostgresExecutor } from "./storage/sql-executor";

const databaseUrl = process.env.DBOS_SYSTEM_DATABASE_URL;
if (!databaseUrl) throw new Error("DBOS_SYSTEM_DATABASE_URL is required");

const sql = PgPostgresExecutor.connect(databaseUrl);
try {
  const applied = await applyMigrations(sql);
  console.log(applied.length === 0 ? "Oakridge schema is current" : `Applied Oakridge migrations: ${applied.join(", ")}`);
} finally {
  await sql.close();
}
