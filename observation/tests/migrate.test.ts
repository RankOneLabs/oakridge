import { expect, test } from "bun:test";
import { randomBytes, createHash } from "node:crypto";
import { Client } from "pg";
import { sql } from "kysely";
import { openDatabase, withTenant } from "../src/storage/database";
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

integration("row security hides another tenant's revision from a least-privilege role", async () => scratch(async (url) => {
  const db = openDatabase(url);
  const role = `observation_reader_${randomBytes(6).toString("hex")}`;
  let hasRole = false;
  try {
    await migrateEmptyDatabase(db);
    await sql.raw(`CREATE ROLE ${role} NOLOGIN`).execute(db);
    hasRole = true;
    await sql.raw(`GRANT USAGE ON SCHEMA observation TO ${role}`).execute(db);
    await sql.raw(`GRANT SELECT ON observation.source_revision TO ${role}`).execute(db);
    await withTenant(db, { producer: "oakridge", namespace: "alpha" }, (trx) => sql`INSERT INTO observation.source_revision
      (producer, namespace, revision_id, run_id, unit_id, artifact_kind, artifact_schema_version,
       definition_bundle_id, definition_bundle_digest, body, body_digest, recorded_at)
      VALUES ('oakridge', 'alpha', 'rev-1', 'run-1', 'unit-1', 'build_result', 'schema-1',
        'bundle-1', 'bundle-digest-1', '{}'::jsonb, ${`canonical-json/v1:${"0".repeat(64)}`}, now())`.execute(trx));

    const countAs = (namespace: string) => db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('observation.producer', 'oakridge', true), set_config('observation.namespace', ${namespace}, true)`.execute(trx);
      await sql.raw(`SET LOCAL ROLE ${role}`).execute(trx);
      const identity = await sql<{ current_user: string; is_superuser: boolean }>`SELECT current_user, rolsuper AS is_superuser
        FROM pg_roles WHERE rolname = current_user`.execute(trx);
      expect(identity.rows[0]).toEqual({ current_user: role, is_superuser: false });
      const rows = await sql<{ count: string }>`SELECT count(*)::text AS count FROM observation.source_revision`.execute(trx);
      return Number(rows.rows[0]?.count);
    });
    expect(await countAs("alpha")).toBe(1);
    expect(await countAs("beta")).toBe(0);
  } finally {
    if (hasRole) {
      await sql.raw(`DROP OWNED BY ${role}`).execute(db);
      await sql.raw(`DROP ROLE ${role}`).execute(db);
    }
    await db.destroy();
  }
}));
