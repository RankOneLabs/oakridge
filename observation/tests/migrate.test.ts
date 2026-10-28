import { expect, test } from "bun:test";
import { randomBytes, createHash } from "node:crypto";
import { Client } from "pg";
import { sql } from "kysely";
import { openDatabase } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";

const serverUrl = process.env.OAKRIDGE_TEST_DATABASE_URL;
const integration = serverUrl || process.env.CI === "true" ? test : test.skip;

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
    finally { await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); }
  } finally { await admin.end(); }
}

integration("fresh baseline applies and a second apply is a no-op", async () => scratch(async (url) => {
  const db = openDatabase(url);
  try {
    await migrateEmptyDatabase(db);
    const first = await sql<{ digest: string }>`SELECT digest FROM observation.schema_baseline`.execute(db);
    const baseline = await Bun.file(new URL("../src/storage/migrations/0001_observation.sql", import.meta.url)).text();
    expect(first.rows[0]?.digest).toBe(createHash("sha256").update(baseline).digest("hex"));
    await migrateEmptyDatabase(db);
    const second = await sql<{ count: string }>`SELECT count(*)::text AS count FROM observation.schema_baseline`.execute(db);
    expect(second.rows[0]?.count).toBe("1");
  } finally { await db.destroy(); }
}));

integration("a changed recorded digest names both values", async () => scratch(async (url) => {
  const db = openDatabase(url);
  try {
    await migrateEmptyDatabase(db);
    const wrong = "0".repeat(64);
    await sql`UPDATE observation.schema_baseline SET digest = ${wrong}`.execute(db);
    const current = createHash("sha256").update(await Bun.file(new URL("../src/storage/migrations/0001_observation.sql", import.meta.url)).text()).digest("hex");
    await expect(migrateEmptyDatabase(db)).rejects.toThrow(`recorded ${wrong}, current ${current}`);
  } finally { await db.destroy(); }
}));

integration("non-empty database without a baseline is refused", async () => scratch(async (url) => {
  const db = openDatabase(url);
  try {
    await sql`CREATE TABLE unrelated (id text PRIMARY KEY)`.execute(db);
    await expect(migrateEmptyDatabase(db)).rejects.toThrow("requires an empty database");
  } finally { await db.destroy(); }
}));
