import { expect, test } from "bun:test";
import { randomBytes, createHash } from "node:crypto";
import { Client } from "pg";
import { readdir, unlink } from "node:fs/promises";
import { sql } from "kysely";
import { openDatabase, withTenant, type Database as ObservationDatabase } from "../src/storage/database";
import { migrateEmptyDatabase, adoptExistingDatabase } from "../src/storage/migrate";
import { migrations } from "../src/storage/migrations/manifest";
import { dropScratchDatabase } from "./database-fixture";
import { openDatabase as openAuthorityDatabase, type Database as AuthorityDatabase } from "../../oakridge-dbos/src/storage/database";
import { migrateEmptyDatabase as migrateAuthority } from "../../oakridge-dbos/src/storage/migrate";
import { cutoverPreflight } from "../../oakridge-dbos/scripts/cutover-preflight";

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
    "0008_langfuse_sync.sql", "0009_grade_label_origin.sql", "0010_question_text_and_evaluator_instructions.sql",
    "0011_evaluation_eligibility.sql", "0012_grading_job.sql", "0013_human_collection_mode.sql",
    "0014_annotation_evaluator_v2.sql",
  ]);
  const files = await readdir(new URL("../src/storage/migrations/", import.meta.url));
  expect(migrations.map((entry) => entry.name).sort()).toEqual(files.filter((name) => name.endsWith(".sql")).sort());
  for (const entry of migrations) expect(await Bun.file(entry.file).exists()).toBe(true);
});

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

integration("old full schema requires explicit adoption and preserves its rows", async () => scratch(async (url) => {
  const db = openDatabase(url);
  try {
    for (const entry of migrations) {
      if (entry.name === "0006_export_guard.sql") continue;
      const source = await Bun.file(entry.file).text();
      await sql.raw(source).execute(db);
      if (entry === migrations[0]) await sql`INSERT INTO observation.schema_baseline (digest) VALUES (${createHash("sha256").update(source).digest("hex")})`.execute(db);
    }
    await sql`INSERT INTO observation.source_revision (producer, namespace, revision_id, run_id, unit_id, artifact_kind,
      artifact_schema_version, definition_bundle_id, definition_bundle_digest, body, body_digest, recorded_at)
      VALUES ('oakridge', 'adoption', 'rev', 'run', 'unit', 'brief', '1', 'bundle', 'digest', '{}'::jsonb,
        ${`canonical-json/v1:${"0".repeat(64)}`}, now())`.execute(db);
    await expect(migrateEmptyDatabase(db)).rejects.toThrow("run storage:adopt");
    expect(await adoptExistingDatabase(db, url)).toEqual([]);
    await migrateEmptyDatabase(db);
    const rows = await sql<{ count: number }>`SELECT count(*)::integer AS count FROM observation.source_revision`.execute(db);
    expect(rows.rows[0]?.count).toBe(1);
    const ledger = await sql<{ count: number }>`SELECT count(*)::integer AS count FROM observation.schema_migration`.execute(db);
    expect(ledger.rows[0]?.count).toBe(migrations.length);
    const guard = await sql<{ source: string }>`SELECT pg_get_functiondef('observation.require_new_export_manifest()'::regprocedure) AS source`.execute(db);
    expect(guard.rows[0]?.source).toContain("mod(pg_current_xact_id()");
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

async function historicSchema(db: ReturnType<typeof openDatabase>): Promise<void> {
  for (const entry of migrations) {
    if (entry.name === "0006_export_guard.sql") continue;
    const source = await Bun.file(entry.file).text();
    await sql.raw(source).execute(db);
    if (entry === migrations[0]) await sql`INSERT INTO observation.schema_baseline (digest) VALUES (${createHash("sha256").update(source).digest("hex")})`.execute(db);
  }
}

integration("adoption names table, column, constraint and index differences", async () => {
  const changes = [
    { category: "tables", statement: "CREATE TABLE observation.extra_adoption_table (id integer)" },
    { category: "columns", statement: "ALTER TABLE observation.schema_baseline ALTER COLUMN digest DROP NOT NULL" },
    { category: "constraints", statement: "ALTER TABLE observation.schema_baseline DROP CONSTRAINT schema_baseline_digest_check" },
    { category: "indexes", statement: "CREATE INDEX extra_adoption_index ON observation.source_revision (run_id)" },
  ];
  for (const change of changes) await scratch(async (url) => {
    const db = openDatabase(url);
    try {
      await historicSchema(db);
      await sql.raw(change.statement).execute(db);
      await expect(adoptExistingDatabase(db, url)).rejects.toThrow(change.category);
    } finally { await db.destroy(); }
  });
});

async function databaseFingerprint(url: string, schema: string): Promise<string> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const catalog = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`, [schema]);
    const contents = [];
    for (const row of catalog.rows as { table_name: string }[]) {
      const data = await client.query(`SELECT to_jsonb(t) AS row FROM ${schema}.${row.table_name} t`);
      contents.push([row.table_name, data.rows.map((item) => JSON.stringify(item.row)).sort()]);
    }
    const columns = await client.query(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position`, [schema]);
    const indexes = await client.query(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = $1 ORDER BY tablename, indexname`, [schema]);
    return createHash("sha256").update(JSON.stringify({ contents, columns: columns.rows, indexes: indexes.rows })).digest("hex");
  } finally { await client.end(); }
}

async function seedPreflightData(authority: AuthorityDatabase, observation: ObservationDatabase): Promise<void> {
  await sql`INSERT INTO authority.definition_bundle (id, digest, source, checked_program, prompts)
    VALUES ('bundle-pinned', 'bundle-digest', '{}'::jsonb, '{"workflow":{}}'::jsonb,
      '{"missing-prompt":"absent-digest"}'::jsonb)`.execute(authority);
  // This scratch fixture deliberately includes a dangling reference for the report to find.
  await sql`ALTER TABLE authority.run DROP CONSTRAINT run_definition_bundle_id_fkey`.execute(authority);
  await sql`INSERT INTO authority.run (id, definition_bundle_id) VALUES
    ('run-running', 'bundle-pinned'), ('run-complete', 'bundle-pinned'),
    ('run-dangling', 'bundle-missing')`.execute(authority);
  await sql`INSERT INTO authority.unit (id, run_id, declaration, status) VALUES
    ('root-running', 'run-running', 'root', '{"kind":"running"}'::jsonb),
    ('root-complete', 'run-complete', 'root', '{"kind":"completed"}'::jsonb)`.execute(authority);
  await sql`UPDATE authority.run SET root_unit_id = 'root-running' WHERE id = 'run-running'`.execute(authority);
  await sql`UPDATE authority.run SET root_unit_id = 'root-complete' WHERE id = 'run-complete'`.execute(authority);
  await sql`INSERT INTO authority.attempt (action_id, seq, run_id, unit_id, worker, mode, cause, status)
    VALUES ('action-running', 0, 'run-running', 'root-running', 'builder', '{}'::jsonb,
      '{}'::jsonb, '{"kind":"running"}'::jsonb)`.execute(authority);
  await sql`INSERT INTO authority.effect_intent (id, run_id, unit_id, action_id, seq, payload, status) VALUES
    ('intent-pending', 'run-running', 'root-running', 'effect-pending', 0, '{}'::jsonb, 'pending')`.execute(authority);
  await sql`INSERT INTO authority.effect_intent (id, run_id, unit_id, action_id, seq, payload, status, stop_origin) VALUES
    ('intent-stopping', 'run-running', 'root-running', 'effect-stopping', 0, '{}'::jsonb,
      'stop_requested', 'executor')`.execute(authority);
  await sql`INSERT INTO observation.source_revision (producer, namespace, revision_id, run_id, unit_id,
    artifact_kind, artifact_schema_version, definition_bundle_id, definition_bundle_digest, body,
    body_digest, recorded_at) VALUES
    ('oakridge', 'preflight', 'revision-1', 'run-running', 'root-running', 'build_result', '1',
      'bundle-pinned', 'bundle-digest', '{}'::jsonb, ${`canonical-json/v1:${"0".repeat(64)}`}, now()),
    ('oakridge', 'preflight', 'revision-2', 'run-complete', 'root-complete', 'pr', '1',
      'bundle-pinned', 'bundle-digest', '{}'::jsonb, ${`canonical-json/v1:${"0".repeat(64)}`}, now())`.execute(observation);
}

integration("cutover preflight reports both databases without changing rows or schema", async () => scratch(async (authorityUrl) => scratch(async (observationUrl) => {
  const authority = openAuthorityDatabase(authorityUrl), observation = openDatabase(observationUrl);
  try {
    await migrateAuthority(authority);
    await migrateEmptyDatabase(observation);
    await seedPreflightData(authority, observation);
    const before = [await databaseFingerprint(authorityUrl, "authority"), await databaseFingerprint(observationUrl, "observation")];
    const report = await cutoverPreflight(authorityUrl, observationUrl);
    expect(report.run_states).toEqual([
      { state: "completed", count: 1 }, { state: "not_started", count: 1 }, { state: "running", count: 1 },
    ]);
    expect(report.pending_authority_work).toEqual([
      { kind: "running_attempt", count: 1 }, { kind: "effect_intent:pending", count: 1 },
      { kind: "effect_intent:stop_requested", count: 1 },
    ]);
    expect(report.referenced_definition_ids).toEqual([
      { id: "bundle-missing", count: 1 }, { id: "bundle-pinned", count: 2 },
    ]);
    expect(report.missing_pinned_dependencies).toEqual([
      { kind: "definition_bundle", id: "bundle-missing" }, { kind: "prompt_content", id: "missing-prompt" },
    ]);
    expect(report.observation_reference_counts).toContainEqual({ kind: "source_revision", count: 2 });
    const after = [await databaseFingerprint(authorityUrl, "authority"), await databaseFingerprint(observationUrl, "observation")];
    expect(after).toEqual(before);
  } finally { await authority.destroy(); await observation.destroy(); }
})));

integration("cutover preflight refuses a row-security-limited observation reader", async () => scratch(async (authorityUrl) => scratch(async (observationUrl) => {
  const authority = openAuthorityDatabase(authorityUrl), observation = openDatabase(observationUrl);
  const role = `preflight_reader_${randomBytes(6).toString("hex")}`;
  const password = randomBytes(16).toString("hex");
  let hasRole = false;
  try {
    await migrateAuthority(authority);
    await migrateEmptyDatabase(observation);
    await sql`INSERT INTO observation.source_revision (producer, namespace, revision_id, run_id, unit_id,
      artifact_kind, artifact_schema_version, definition_bundle_id, definition_bundle_digest, body,
      body_digest, recorded_at) VALUES ('oakridge', 'preflight', 'revision-1', 'run-1', 'unit-1',
      'build_result', '1', 'bundle-1', 'digest-1', '{}'::jsonb,
      ${`canonical-json/v1:${"0".repeat(64)}`}, now())`.execute(observation);
    await sql.raw(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`).execute(observation);
    hasRole = true;
    await sql.raw(`GRANT USAGE ON SCHEMA observation TO ${role}`).execute(observation);
    await sql.raw(`GRANT SELECT ON observation.source_revision, observation.item_occurrence, observation.grade_observation TO ${role}`).execute(observation);
    const restrictedUrl = new URL(observationUrl);
    restrictedUrl.username = role;
    restrictedUrl.password = password;
    const restricted = openDatabase(restrictedUrl.href);
    try {
      const hidden = await sql<{ count: string }>`SELECT count(*)::text AS count FROM observation.source_revision`.execute(restricted);
      expect(hidden.rows[0]?.count).toBe("0");
    } finally { await restricted.destroy(); }
    await expect(cutoverPreflight(authorityUrl, restrictedUrl.href)).rejects.toThrow("BYPASSRLS");
  } finally {
    if (hasRole) {
      await sql.raw(`DROP OWNED BY ${role}`).execute(observation);
      await sql.raw(`DROP ROLE ${role}`).execute(observation);
    }
    await authority.destroy();
    await observation.destroy();
  }
})));

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
