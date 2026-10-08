/**
 * Generates src/storage/generated-records.ts from the authority baseline. The
 * baseline is applied to a scratch database on OAKRIDGE_TEST_DATABASE_URL's
 * server, pg-to-ts reads the resulting catalog, and the scratch database is
 * dropped. `--check` fails when the committed file differs.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { typescriptOfSchema } from "pg-to-ts";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { PgPostgresExecutor } from "../src/storage/sql-executor";

const output = resolve(import.meta.dir, "../src/storage/generated-records.ts");
const HEADER = "// Generated from src/storage/migrations/0001_core_authority.sql. Run bun oakridge-dbos/scripts/generate-storage-records.ts.\n"
  + "// jsonb column types come from each column's @type comment, resolved in json-column-types.ts.\n\n";

function scratchUrl(server_url: string, database: string): string {
  const url = new URL(server_url);
  url.pathname = `/${database}`;
  return url.toString();
}

async function withScratchDatabase<Value>(server_url: string, operation: (url: string) => Promise<Value>): Promise<Value> {
  const database = `oakridge_records_${randomBytes(6).toString("hex")}`;
  const admin = new Client({ connectionString: server_url });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${database}`);
    try { return await operation(scratchUrl(server_url, database)); }
    finally { await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); }
  } finally { await admin.end(); }
}

async function generate(server_url: string): Promise<string> {
  return withScratchDatabase(server_url, async (url) => {
    const db = PgPostgresExecutor.connect(url);
    try { await migrateEmptyDatabase(db); }
    finally { await db.close(); }
    const records = await typescriptOfSchema(url, [], ["schema_baseline"], "authority",
      { writeHeader: false, jsonTypesFile: "./json-column-types" });
    return HEADER + records;
  });
}

const server_url = process.env.OAKRIDGE_TEST_DATABASE_URL;
if (!server_url) {
  console.error("OAKRIDGE_TEST_DATABASE_URL is required: a PostgreSQL 15+ server where a scratch database can be created and dropped");
  process.exit(2);
}
const generated = await generate(server_url);
if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== generated) {
    console.error("generated-records.ts has drifted; run bun oakridge-dbos/scripts/generate-storage-records.ts");
    process.exit(1);
  }
} else writeFileSync(output, generated);
// pg-to-ts keeps a pg-promise pool open.
process.exit(0);
