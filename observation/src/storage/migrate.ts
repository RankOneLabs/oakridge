import { createHash } from "node:crypto";
import { sql } from "kysely";
import { openDatabase, type Database } from "./database";

const migration = new URL("./migrations/0001_observation.sql", import.meta.url);
const MINIMUM_SERVER_VERSION = 150000;

export async function migrateEmptyDatabase(db: Database): Promise<void> {
  const version = await sql<{ server_version_num: string }>`SELECT current_setting('server_version_num') AS server_version_num`.execute(db);
  if (Number(version.rows[0]?.server_version_num ?? 0) < MINIMUM_SERVER_VERSION) throw new Error("PostgreSQL 15+ is required for the observation baseline");
  const baseline = await Bun.file(migration).text();
  const digest = createHash("sha256").update(baseline).digest("hex");
  await db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'observation:baseline'}, 0))`.execute(trx);
    const relation = await sql<{ name: string | null }>`SELECT to_regclass('observation.schema_baseline')::text AS name`.execute(trx);
    const recorded = relation.rows[0]?.name
      ? await sql<{ digest: string }>`SELECT digest FROM observation.schema_baseline LIMIT 1`.execute(trx) : null;
    const applied = recorded?.rows[0];
    if (applied) {
      if (applied.digest !== digest) throw new Error(`observation baseline digest mismatch: recorded ${applied.digest}, current ${digest}`);
      return;
    }
    const existing = await sql<{ table_name: string }>`SELECT table_schema || '.' || table_name AS table_name FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'dbos') AND table_schema NOT LIKE 'dbos_%' AND table_type = 'BASE TABLE' LIMIT 1`.execute(trx);
    if (existing.rows[0]) throw new Error(`observation baseline requires an empty database; found ${existing.rows[0].table_name}`);
    await sql.raw(baseline).execute(trx);
    await sql`INSERT INTO observation.schema_baseline (digest) VALUES (${digest})`.execute(trx);
  });
}

if (import.meta.main) {
  const url = process.env.OBSERVATION_DATABASE_URL;
  if (!url) throw new Error("OBSERVATION_DATABASE_URL is required");
  const db = openDatabase(url);
  try { await migrateEmptyDatabase(db); }
  finally { await db.destroy(); }
}
