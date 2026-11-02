import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { sql } from "kysely";
import { openDatabase } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { dropScratchDatabase } from "./database-fixture";

const serverUrl = process.env.OAKRIDGE_TEST_DATABASE_URL;
const integration = serverUrl ? test : test.skip;

async function scratch(work: (url: string) => Promise<void>): Promise<void> {
  if (!serverUrl) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required");
  const name = `observation_test_${randomBytes(6).toString("hex")}`;
  const admin = new Client({ connectionString: serverUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(serverUrl);
    url.pathname = `/${name}`;
    try { await work(url.href); }
    finally { await dropScratchDatabase(admin, name); }
  } finally { await admin.end(); }
}


integration("fresh schema has local grading tables and repeats without applying upgrades", async () => scratch(async (url) => {
  const db = openDatabase(url);
  try {
    await migrateEmptyDatabase(db);
    await migrateEmptyDatabase(db);
    const result = await sql<{ jobs: string | null; attempts: string | null; forbidden: number; baselines: number }>`SELECT
      to_regclass('observation.grading_job')::text AS jobs,
      to_regclass('observation.grading_provider_attempt')::text AS attempts,
      (SELECT count(*)::integer FROM pg_tables WHERE schemaname = 'observation' AND tablename LIKE 'langfuse%') AS forbidden,
      (SELECT count(*)::integer FROM observation.schema_baseline) AS baselines`.execute(db);
    expect(result.rows[0]).toEqual({ jobs: "observation.grading_job", attempts: "observation.grading_provider_attempt", forbidden: 0, baselines: 1 });
  } finally { await db.destroy(); }
}));

integration("an incompatible schema is refused instead of adopted", async () => scratch(async (url) => {
  const db = openDatabase(url);
  try {
    await migrateEmptyDatabase(db);
    await sql`UPDATE observation.schema_baseline SET digest = ${"0".repeat(64)}`.execute(db);
    await expect(migrateEmptyDatabase(db)).rejects.toThrow("baseline digest mismatch");
  } finally { await db.destroy(); }
}));
