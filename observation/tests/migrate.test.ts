import { expect, test } from "bun:test";
import { randomBytes, createHash } from "node:crypto";
import { Client } from "pg";
import { sql } from "kysely";
import { openDatabase, withTenant } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { dropScratchDatabase } from "./database-fixture";

const serverUrl = process.env.OAKRIDGE_TEST_DATABASE_URL;
const integration = serverUrl || process.env.CI === "true" ? test : test.skip;

integration("0010 and 0011 upgrade 0009 without changing pinned v1 question fields", async () => scratch(async (url) => {
  const db = openDatabase(url);
  try {
    const names = ["0001_observation.sql", "0002_projection.sql", "0003_revision_links.sql", "0003_grading.sql",
      "0004_cursor.sql", "0005_export.sql", "0006_export_guard.sql", "0007_purge.sql",
      "0008_langfuse_sync.sql", "0009_grade_label_origin.sql"];
    for (const name of names) {
      const source = await Bun.file(new URL(`../src/storage/migrations/${name}`, import.meta.url)).text();
      await sql.raw(source).execute(db);
      if (name === "0001_observation.sql") await sql`INSERT INTO observation.schema_baseline (digest)
        VALUES (${createHash("sha256").update(source).digest("hex")})`.execute(db);
    }
    for (const question_id of ["analysis.finding_relevance", "plan.criterion_traceability", "brief.source_fidelity", "assessment.coverage"])
      await withTenant(db, { producer: "oakridge", namespace: "pin" }, (trx) => sql`INSERT INTO observation.question_definition
        (producer, namespace, question_id, question_version, target_item_kinds, input_recipe, response_kind,
         allowed_values, missing_evidence_policy, abstain_semantics, unclear_semantics, interpretation_caveats, requires_repository_snapshot)
        VALUES ('oakridge', 'pin', ${question_id}, 'v1', '["criterion"]'::jsonb, '{}'::jsonb,
          'boolean', NULL, 'fail', '', '', '', false)`.execute(trx));
    const before = await withTenant(db, { producer: "oakridge", namespace: "pin" }, (trx) => sql<{ row: unknown }>`
      SELECT to_jsonb(q) AS row FROM observation.question_definition q ORDER BY question_id`.execute(trx));
    await migrateEmptyDatabase(db);
    const eligibility = await sql<{ name: string | null }>`SELECT to_regclass('observation.evaluation_eligibility')::text AS name`.execute(db);
    expect(eligibility.rows[0]?.name).toBe("observation.evaluation_eligibility");
    const after = await withTenant(db, { producer: "oakridge", namespace: "pin" }, (trx) => sql<{ row: unknown }>`
      SELECT to_jsonb(q) - 'question_text' - 'evidence_recipe_provenance' AS row
      FROM observation.question_definition q ORDER BY question_id`.execute(trx));
    expect(after.rows).toEqual(before.rows);
    const columns = await sql<{ question_text: string | null; eligibility: string | null }>`
      SELECT (SELECT column_name FROM information_schema.columns WHERE table_schema = 'observation'
        AND table_name = 'question_definition' AND column_name = 'question_text') AS question_text,
        to_regclass('observation.evaluation_eligibility')::text AS eligibility`.execute(db);
    expect(columns.rows[0]).toEqual({ question_text: "question_text", eligibility: "observation.evaluation_eligibility" });
    await migrateEmptyDatabase(db);
  } finally { await db.destroy(); }
}));

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

integration("populated 0001 through 0007 database upgrades additively to Langfuse storage", async () => scratch(async (url) => {
  const db = openDatabase(url);
  try {
    const baseline = await Bun.file(new URL("../src/storage/migrations/0001_observation.sql", import.meta.url)).text();
    const digest = createHash("sha256").update(baseline).digest("hex");
    await sql.raw(baseline).execute(db);
    await sql`INSERT INTO observation.schema_baseline (digest) VALUES (${digest})`.execute(db);
    for (const name of ["0002_projection.sql", "0003_revision_links.sql", "0003_grading.sql", "0004_cursor.sql",
      "0005_export.sql", "0006_export_guard.sql", "0007_purge.sql"]) {
      const migration = await Bun.file(new URL(`../src/storage/migrations/${name}`, import.meta.url)).text();
      await sql.raw(migration).execute(db);
    }
    await withTenant(db, { producer: "oakridge", namespace: "upgrade" }, (trx) => sql`
      INSERT INTO observation.source_revision (producer, namespace, revision_id, run_id, unit_id, artifact_kind,
        artifact_schema_version, definition_bundle_id, definition_bundle_digest, body, body_digest, recorded_at)
      VALUES ('oakridge', 'upgrade', 'rev-1', 'run-1', 'unit-1', 'brief', '1', 'bundle', 'digest',
        '{}'::jsonb, ${`canonical-json/v1:${"0".repeat(64)}`}, now())`.execute(trx));
    await migrateEmptyDatabase(db);
    const state = await sql<{ digest: string; mapping: string | null; revision_count: string }>`
      SELECT (SELECT digest FROM observation.schema_baseline) AS digest,
        to_regclass('observation.langfuse_mapping')::text AS mapping,
        (SELECT count(*)::text FROM observation.source_revision) AS revision_count`.execute(db);
    expect(state.rows[0]).toEqual({ digest, mapping: "observation.langfuse_mapping", revision_count: "1" });
    await migrateEmptyDatabase(db);
  } finally { await db.destroy(); }
}));

integration("an existing L0 plus projection database gains nullable revision links without changing its baseline", async () => scratch(async (url) => {
  const db = openDatabase(url);
  try {
    const baseline = await Bun.file(new URL("../src/storage/migrations/0001_observation.sql", import.meta.url)).text();
    const projection = await Bun.file(new URL("../src/storage/migrations/0002_projection.sql", import.meta.url)).text();
    await sql.raw(baseline).execute(db);
    const digest = createHash("sha256").update(baseline).digest("hex");
    await sql`INSERT INTO observation.schema_baseline (digest) VALUES (${digest})`.execute(db);
    await sql.raw(projection).execute(db);
    await migrateEmptyDatabase(db);
    const columns = await sql<{ column_name: string }>`SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'observation' AND table_name = 'source_revision'
      AND column_name IN ('predecessor_id', 'subject_id') ORDER BY column_name`.execute(db);
    expect(columns.rows.map((row) => row.column_name)).toEqual(["predecessor_id", "subject_id"]);
    const after = await sql<{ digest: string }>`SELECT digest FROM observation.schema_baseline`.execute(db);
    expect(after.rows[0]?.digest).toBe(digest);
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
