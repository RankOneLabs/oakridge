import { expect, test } from "bun:test";
import { randomBytes, createHash } from "node:crypto";
import { Client } from "pg";
import { readdir, unlink } from "node:fs/promises";
import { sql } from "kysely";
import { openDatabase, withTenant } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { migrations } from "../src/storage/migrations/manifest";
import { dropScratchDatabase } from "./database-fixture";

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
    finally { await dropScratchDatabase(admin, name); }
  } finally { await admin.end(); }
}

integration("manifest pins all files in historical order", async () => {
  expect(migrations.map((entry) => entry.name)).toEqual([
    "0001_observation.sql", "0002_projection.sql", "0003_revision_links.sql", "0003_grading.sql",
    "0004_cursor.sql", "0005_export.sql", "0006_export_guard.sql", "0007_purge.sql",
    "0009_grade_label_origin.sql", "0010_question_text_and_evaluator_instructions.sql",
    "0012_grading_job.sql", "0013_human_collection_mode.sql",
    "0015_definition_identity.sql", "0016_source_event_issue.sql", "0017_source_repair_position.sql",
    "0018_grading_attempt_accounting.sql", "0019_question_unclear_choice.sql",
  ]);
  const files = await readdir(new URL("../src/storage/migrations/", import.meta.url));
  expect(migrations.map((entry) => entry.name).sort()).toEqual(files.filter((name) => name.endsWith(".sql")).sort());
  for (const entry of migrations) expect(await Bun.file(entry.file).exists()).toBe(true);
});

integration("definition identity migration keeps legacy provenance and permits new IDs alone", async () => scratch(async (url) => {
  const db = openDatabase(url);
  try {
    await migrateEmptyDatabase(db, migrations.slice(0, -1));
    await withTenant(db, { producer: "oakridge", namespace: "cutover" }, (trx) =>
      sql`INSERT INTO observation.source_revision (producer, namespace, revision_id, run_id, unit_id,
        artifact_kind, artifact_schema_version, definition_bundle_id, definition_bundle_digest,
        body, body_digest, recorded_at) VALUES ('oakridge', 'cutover', 'old', 'run', 'unit', 'brief', '1',
        'bundle', 'digest', '{}'::jsonb, ${`canonical-json/v1:${"0".repeat(64)}`}, now())`.execute(trx));
    await migrateEmptyDatabase(db);
    await withTenant(db, { producer: "oakridge", namespace: "cutover" }, (trx) =>
      sql`INSERT INTO observation.source_revision (producer, namespace, revision_id, run_id, unit_id,
        artifact_kind, artifact_schema_version, definition_id, body, body_digest, recorded_at)
        VALUES ('oakridge', 'cutover', 'new', 'run', 'unit', 'brief', '1', ${"a".repeat(64)}, '{}'::jsonb,
        ${`canonical-json/v1:${"0".repeat(64)}`}, now())`.execute(trx));
    const rows = await withTenant(db, { producer: "oakridge", namespace: "cutover" }, (trx) =>
      sql<{ revision_id: string; definition_id: string | null; definition_bundle_id: string | null; definition_bundle_digest: string | null }>`
        SELECT revision_id, definition_id, definition_bundle_id, definition_bundle_digest
        FROM observation.source_revision ORDER BY revision_id`.execute(trx));
    expect(rows.rows).toEqual([
      { revision_id: "new", definition_id: "a".repeat(64), definition_bundle_id: null, definition_bundle_digest: null },
      { revision_id: "old", definition_id: null, definition_bundle_id: "bundle", definition_bundle_digest: "digest" },
    ]);
  } finally { await db.destroy(); }
}));

integration("fresh migration ledger records the ordered chain and exact file digests", async () => scratch(async (url) => {
  const db = openDatabase(url);
  try {
    await migrateEmptyDatabase(db);
    const rows = await sql<{ name: string; digest: string; applied_at: Date }>`SELECT name, digest, applied_at FROM observation.schema_migration ORDER BY ordinal`.execute(db);
    expect(rows.rows.map((row) => row.name)).toEqual(migrations.map((entry) => entry.name));
    for (const [index, row] of rows.rows.entries()) {
      const bytes = await Bun.file(migrations[index]!.file).arrayBuffer();
      expect(row.digest).toBe(createHash("sha256").update(new Uint8Array(bytes)).digest("hex"));
      expect(row.applied_at).toBeInstanceOf(Date);
    }
    await migrateEmptyDatabase(db);
    const count = await sql<{ count: number }>`SELECT count(*)::integer AS count FROM observation.schema_migration`.execute(db);
    expect(count.rows[0]?.count).toBe(migrations.length);
  } finally { await db.destroy(); }
}));

integration("two concurrent starters apply each migration once", async () => scratch(async (url) => {
  const first = openDatabase(url), second = openDatabase(url);
  try {
    await Promise.all([migrateEmptyDatabase(first), migrateEmptyDatabase(second)]);
    const rows = await sql<{ count: number }>`SELECT count(*)::integer AS count FROM observation.schema_migration`.execute(first);
    expect(rows.rows[0]?.count).toBe(migrations.length);
  } finally { await first.destroy(); await second.destroy(); }
}));

async function temporarySql(source: string, work: (file: URL) => Promise<void>): Promise<void> {
  const path = `/tmp/observation_migration_${randomBytes(6).toString("hex")}.sql`;
  await Bun.write(path, source);
  try { await work(new URL(`file://${path}`)); }
  finally { await unlink(path); }
}

integration("a forward migration runs once and a failure rolls back only its own work", async () => scratch(async (url) => {
  const db = openDatabase(url);
  try {
    await migrateEmptyDatabase(db);
    const name = "0015_forward_test.sql";
    await temporarySql("CREATE TABLE observation.forward_test (id integer); SELECT 1 / 0;", async (file) => {
      await expect(migrateEmptyDatabase(db, [...migrations, { name, file }])).rejects.toThrow();
    });
    const afterFailure = await sql<{ count: number; relation: string | null }>`SELECT
      (SELECT count(*)::integer FROM observation.schema_migration) AS count,
      to_regclass('observation.forward_test')::text AS relation`.execute(db);
    expect(afterFailure.rows[0]).toEqual({ count: migrations.length, relation: null });
    await temporarySql("CREATE TABLE observation.forward_test (id integer);", async (file) => {
      const chain = [...migrations, { name, file }];
      await migrateEmptyDatabase(db, chain);
      await migrateEmptyDatabase(db, chain);
    });
    const afterRetry = await sql<{ count: number }>`SELECT count(*)::integer AS count FROM observation.schema_migration`.execute(db);
    expect(afterRetry.rows[0]?.count).toBe(migrations.length + 1);
  } finally { await db.destroy(); }
}));

integration("changed bytes of a later applied migration refuse startup by name", async () => scratch(async (url) => {
  const db = openDatabase(url);
  try {
    await migrateEmptyDatabase(db);
    const changed = migrations[3]!;
    await temporarySql(`${await Bun.file(changed.file).text()}\n-- altered`, async (file) => {
      const entries = migrations.map((entry) => entry === changed ? { name: entry.name, file } : entry);
      await expect(migrateEmptyDatabase(db, entries)).rejects.toThrow(changed.name);
    });
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
