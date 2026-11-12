import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "pg";
import { sql } from "kysely";
import { openDatabase } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { readdir } from "node:fs/promises";
import { jsonText } from "../src/storage/database";
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


integration("fresh schema repeats without applying upgrades", async () => scratch(async (url) => {
  const db = openDatabase(url);
  try {
    await migrateEmptyDatabase(db);
    await migrateEmptyDatabase(db);
    const result = await sql<{ attempts: string | null; forbidden: number; baselines: number }>`SELECT
      to_regclass('observation.grading_provider_attempt')::text AS attempts,
      (SELECT count(*)::integer FROM pg_tables WHERE schemaname = 'observation' AND tablename LIKE 'langfuse%') AS forbidden,
      (SELECT count(*)::integer FROM observation.schema_baseline) AS baselines`.execute(db);
    expect(result.rows[0]).toEqual({ attempts: "observation.grading_provider_attempt", forbidden: 0, baselines: 1 });
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

interface CatalogEntry { readonly kind: string; readonly table_name: string; readonly name: string; readonly definition: string }
const compareCatalogEntries = (left: CatalogEntry, right: CatalogEntry): number =>
  left.kind.localeCompare(right.kind) || left.table_name.localeCompare(right.table_name) || left.name.localeCompare(right.name);

const observationCatalogQuery = sql.raw<CatalogEntry>(`SELECT 'table' AS kind, c.relname AS table_name, c.relname AS name, '' AS definition
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='observation' AND c.relkind='r'
UNION ALL
SELECT 'column', c.relname, a.attname, format_type(a.atttypid,a.atttypmod) || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE ' NULL' END || ' DEFAULT ' || coalesce(pg_get_expr(d.adbin,d.adrelid),'') || ' GENERATED ' || a.attgenerated::text
FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname='observation' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
UNION ALL
SELECT 'constraint', c.relname, con.conname, pg_get_constraintdef(con.oid) FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='observation'
UNION ALL
SELECT 'index', t.relname, i.relname, pg_get_indexdef(i.oid) FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_class t ON t.oid=x.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='observation'
UNION ALL
SELECT 'trigger', c.relname, t.tgname, pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='observation' AND NOT t.tgisinternal
UNION ALL
SELECT 'function', '', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', pg_get_functiondef(p.oid)
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='observation' AND p.prokind='f'
UNION ALL
SELECT 'policy', c.relname, p.polname, jsonb_build_object(
  'command', p.polcmd::text, 'permissive', p.polpermissive,
  'roles', ARRAY(SELECT CASE WHEN role_id=0 THEN 'public' ELSE pg_get_userbyid(role_id)::text END FROM unnest(p.polroles) AS roles(role_id) ORDER BY 1),
  'using', pg_get_expr(p.polqual,p.polrelid), 'with_check', pg_get_expr(p.polwithcheck,p.polrelid))::text
FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='observation'
UNION ALL
SELECT 'row_security', c.relname, c.relname, jsonb_build_object('enabled', c.relrowsecurity, 'forced', c.relforcerowsecurity)::text
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='observation' AND c.relkind='r'
ORDER BY kind,table_name,name`);

interface CatalogProtectionChange { readonly description: string; readonly statement: string }
const protectionChanges: readonly CatalogProtectionChange[] = [
  { description: "a weakened append-only function", statement: "CREATE OR REPLACE FUNCTION observation.reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN OLD; END $$" },
  { description: "a weakened tenant policy", statement: "ALTER POLICY source_revision_tenant ON observation.source_revision USING (true)" },
  { description: "disabled row-level security", statement: "ALTER TABLE observation.source_revision DISABLE ROW LEVEL SECURITY" },
  { description: "unforced row-level security", statement: "ALTER TABLE observation.source_revision NO FORCE ROW LEVEL SECURITY" },
];
for (const change of protectionChanges) {
  integration(`catalog comparison detects ${change.description}`, async () => scratch(async (url) => {
    const db = openDatabase(url);
    try {
      await migrateEmptyDatabase(db);
      const before = await observationCatalogQuery.execute(db);
      await sql.raw(change.statement).execute(db);
      const after = await observationCatalogQuery.execute(db);
      expect(after.rows.sort(compareCatalogEntries)).not.toEqual(before.rows.sort(compareCatalogEntries));
    } finally { await db.destroy(); }
  }));
}

test("only the consolidated observation SQL baseline is committed", async () => {
  const names = await readdir(new URL("../src/storage/migrations", import.meta.url));
  expect(names.filter((name) => name.endsWith(".sql"))).toEqual(["0001_observation.sql"]);
});

integration("the recorded digest is the SHA-256 of the whole baseline text", async () => scratch(async (url) => {
  const db = openDatabase(url);
  try {
    await migrateEmptyDatabase(db);
    const baseline = await Bun.file(new URL("../src/storage/migrations/0001_observation.sql", import.meta.url)).text();
    const recorded = await db.selectFrom("observation.schema_baseline").select("digest").execute();
    expect(recorded).toEqual([{ digest: createHash("sha256").update(baseline).digest("hex") }]);
  } finally { await db.destroy(); }
}));

integration("a nonempty database is refused before applying any baseline DDL", async () => scratch(async (url) => {
  const db = openDatabase(url);
  try {
    await sql`CREATE TABLE public.stray (id integer)`.execute(db);
    await expect(migrateEmptyDatabase(db)).rejects.toThrow("observation baseline requires an empty database");
    const schema = await sql<{ name: string | null }>`SELECT to_regnamespace('observation')::text AS name`.execute(db);
    expect(schema.rows).toEqual([{ name: null }]);
  } finally { await db.destroy(); }
}));

integration("PostgreSQL versions below 15 are refused before DDL", async () => scratch(async (url) => {
  const db = openDatabase(url);
  // Emulate the older server's version response at the database IO boundary.
  const olderServer = db.withPlugin({ transformQuery: ({ node }) => node,
    transformResult: async ({ result }) => ({ ...result, rows: [{ server_version_num: "140000" }] }) });
  try {
    await expect(migrateEmptyDatabase(olderServer)).rejects.toThrow("PostgreSQL 15+ is required for the observation baseline");
    const schema = await sql<{ name: string | null }>`SELECT to_regnamespace('observation')::text AS name`.execute(db);
    expect(schema.rows).toEqual([{ name: null }]);
  } finally { await db.destroy(); }
}));

/** Exercise the edited baseline through real capture, then probe its subject constraints. */
async function baselineSubject(db: import("../src/storage/database").Database) {
  const { createFeed, fixtureBody, evaluator, evaluatorId, OAKRIDGE_QUESTIONS, targetOf, tenant } = await import("./grading-fixture");
  const { registerQuestion, registerEvaluator } = await import("../src/storage/grading-store");
  const question = OAKRIDGE_QUESTIONS[0]!;
  await registerQuestion(db, tenant, question);
  await registerEvaluator(db, tenant, evaluator("human"));
  await createFeed(db, tenant, { pins: [{ scope: "per_item", ...question, ...targetOf(question.question_id), evaluator_definition_ids: [evaluatorId("human")] }] })
    .revision({ revision_id: "analysis", artifact_kind: "analysis", body: await fixtureBody("analysis") });
  return (await db.selectFrom("observation.evidence_set").selectAll().executeTakeFirstOrThrow());
}

integration("the baseline refuses a duplicate null-task subject", async () => scratch(async (url) => {
  const db = openDatabase(url);
  try {
    await migrateEmptyDatabase(db);
    const row = await baselineSubject(db);
    await expect(db.insertInto("observation.evidence_set").values({ ...row, evidence_refs: jsonText(row.evidence_refs),
      evidence_set_id: `canonical-json/v1:${"f".repeat(64)}` }).execute()).rejects.toThrow("duplicate key");
  } finally { await db.destroy(); }
}));

integration("execution tasks must match their evidence including null against non-null", async () => scratch(async (url) => {
  const db = openDatabase(url);
  try {
    await migrateEmptyDatabase(db);
    const row = await baselineSubject(db);
    for (const task of ["oakridge:grading-test:run-1:task:T3", "oakridge:grading-test:run-1:task:T7"]) await db.insertInto("observation.logical_item").values({
      producer: row.producer, namespace: row.namespace, logical_item_id: task, run_id: "run-1", scope: "task", producer_local_id: task.split(":").at(-1)!,
    }).execute();
    await db.insertInto("observation.evidence_set").values({ ...row, evidence_refs: jsonText(row.evidence_refs), task_id: "oakridge:grading-test:run-1:task:T3",
      evidence_set_id: `canonical-json/v1:${"e".repeat(64)}`, readiness: "ready", not_ready_code: null,
      not_ready_detail: null, ready_at: new Date() }).execute();
    for (const task of [null, "oakridge:grading-test:run-1:task:T7"]) {
      await expect(sql`INSERT INTO observation.evaluation_execution
        (producer, namespace, execution_id, run_id, subject_occurrence_id, task_id, evidence_set_id,
         question_id, question_version, evaluator_definition_id, attempt_label, idempotency_digest, status)
        VALUES (${row.producer}, ${row.namespace}, 'mismatch', 'run-1', ${row.subject_occurrence_id}, ${task},
         ${`canonical-json/v1:${"e".repeat(64)}`}, ${row.question_id}, ${row.question_version}, 'human', 'test',
         ${`canonical-json/v1:${"d".repeat(64)}`}, 'queued')`.execute(db)).rejects.toThrow("execution requires");
    }
  } finally { await db.destroy(); }
}));
