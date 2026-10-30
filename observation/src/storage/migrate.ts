import { createHash } from "node:crypto";
import { sql } from "kysely";
import { openDatabase, type Database } from "./database";

const migration = new URL("./migrations/0001_observation.sql", import.meta.url);
const projectionMigration = new URL("./migrations/0002_projection.sql", import.meta.url);
const revisionLinksMigration = new URL("./migrations/0003_revision_links.sql", import.meta.url);
const gradingMigration = new URL("./migrations/0003_grading.sql", import.meta.url);
const cursorMigration = new URL("./migrations/0004_cursor.sql", import.meta.url);
const exportMigration = new URL("./migrations/0005_export.sql", import.meta.url);
const exportGuardMigration = new URL("./migrations/0006_export_guard.sql", import.meta.url);
const purgeMigration = new URL("./migrations/0007_purge.sql", import.meta.url);
const langfuseSyncMigration = new URL("./migrations/0008_langfuse_sync.sql", import.meta.url);
const gradeLabelOriginMigration = new URL("./migrations/0009_grade_label_origin.sql", import.meta.url);
const questionTextMigration = new URL("./migrations/0010_question_text_and_evaluator_instructions.sql", import.meta.url);
const eligibilityMigration = new URL("./migrations/0011_evaluation_eligibility.sql", import.meta.url);
const gradingJobMigration = new URL("./migrations/0012_grading_job.sql", import.meta.url);
const MINIMUM_SERVER_VERSION = 150000;

export async function migrateEmptyDatabase(db: Database): Promise<void> {
  const version = await sql<{ server_version_num: string }>`SELECT current_setting('server_version_num') AS server_version_num`.execute(db);
  if (Number(version.rows[0]?.server_version_num ?? 0) < MINIMUM_SERVER_VERSION) throw new Error("PostgreSQL 15+ is required for the observation baseline");
  const baseline = await Bun.file(migration).text();
  const projection = await Bun.file(projectionMigration).text();
  const revisionLinks = await Bun.file(revisionLinksMigration).text();
  const grading = await Bun.file(gradingMigration).text();
  const cursor = await Bun.file(cursorMigration).text();
  const exportSql = await Bun.file(exportMigration).text();
  const exportGuardSql = await Bun.file(exportGuardMigration).text();
  const purgeSql = await Bun.file(purgeMigration).text();
  const langfuseSyncSql = await Bun.file(langfuseSyncMigration).text();
  const gradeLabelOriginSql = await Bun.file(gradeLabelOriginMigration).text();
  const questionTextSql = await Bun.file(questionTextMigration).text();
  const eligibilitySql = await Bun.file(eligibilityMigration).text();
  const gradingJobSql = await Bun.file(gradingJobMigration).text();
  const digest = createHash("sha256").update(baseline).digest("hex");
  await db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'observation:baseline'}, 0))`.execute(trx);
    const relation = await sql<{ name: string | null }>`SELECT to_regclass('observation.schema_baseline')::text AS name`.execute(trx);
    const recorded = relation.rows[0]?.name
      ? await sql<{ digest: string }>`SELECT digest FROM observation.schema_baseline LIMIT 1`.execute(trx) : null;
    const applied = recorded?.rows[0];
    if (applied) {
      if (applied.digest !== digest) throw new Error(`observation baseline digest mismatch: recorded ${applied.digest}, current ${digest}`);
    } else {
      const existing = await sql<{ table_name: string }>`SELECT table_schema || '.' || table_name AS table_name FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'dbos') AND table_schema NOT LIKE 'dbos_%' AND table_type = 'BASE TABLE' LIMIT 1`.execute(trx);
      if (existing.rows[0]) throw new Error(`observation baseline requires an empty database; found ${existing.rows[0].table_name}`);
      await sql.raw(baseline).execute(trx);
      await sql`INSERT INTO observation.schema_baseline (digest) VALUES (${digest})`.execute(trx);
    }
    const projected = await sql<{ name: string | null }>`SELECT to_regclass('observation.extractor_definition')::text AS name`.execute(trx);
    if (!projected.rows[0]?.name) await sql.raw(projection).execute(trx);
    const links = await sql<{ has_column: boolean }>`SELECT EXISTS (
      SELECT 1 FROM information_schema.columns WHERE table_schema = 'observation'
      AND table_name = 'source_revision' AND column_name = 'predecessor_id') AS has_column`.execute(trx);
    if (!links.rows[0]?.has_column) await sql.raw(revisionLinks).execute(trx);
    const grades = await sql<{ name: string | null }>`SELECT to_regclass('observation.grade_observation')::text AS name`.execute(trx);
    if (!grades.rows[0]?.name) await sql.raw(grading).execute(trx);
    const sourceCursor = await sql<{ name: string | null }>`SELECT to_regclass('observation.source_event_cursor')::text AS name`.execute(trx);
    if (!sourceCursor.rows[0]?.name) await sql.raw(cursor).execute(trx);
    const exports = await sql<{ name: string | null }>`SELECT to_regclass('observation.export_manifest')::text AS name`.execute(trx);
    if (!exports.rows[0]?.name) await sql.raw(exportSql).execute(trx);
    // The function replacement is idempotent and also upgrades databases that already have 0005.
    await sql.raw(exportGuardSql).execute(trx);
    const purges = await sql<{ name: string | null }>`SELECT to_regclass('observation.purge_event')::text AS name`.execute(trx);
    if (!purges.rows[0]?.name) await sql.raw(purgeSql).execute(trx);
    const langfuseMappings = await sql<{ name: string | null }>`SELECT to_regclass('observation.langfuse_mapping')::text AS name`.execute(trx);
    if (!langfuseMappings.rows[0]?.name) await sql.raw(langfuseSyncSql).execute(trx);
    const labelOrigin = await sql<{ has_column: boolean }>`SELECT EXISTS (
      SELECT 1 FROM information_schema.columns WHERE table_schema = 'observation'
      AND table_name = 'grade_observation' AND column_name = 'label_origin') AS has_column`.execute(trx);
    if (!labelOrigin.rows[0]?.has_column) await sql.raw(gradeLabelOriginSql).execute(trx);
    const questionText = await sql<{ has_column: boolean }>`SELECT EXISTS (
      SELECT 1 FROM information_schema.columns WHERE table_schema = 'observation'
      AND table_name = 'question_definition' AND column_name = 'question_text') AS has_column`.execute(trx);
    if (!questionText.rows[0]?.has_column) await sql.raw(questionTextSql).execute(trx);
    const eligibility = await sql<{ name: string | null }>`SELECT to_regclass('observation.evaluation_eligibility')::text AS name`.execute(trx);
    if (!eligibility.rows[0]?.name) await sql.raw(eligibilitySql).execute(trx);
    const job = await sql<{ name: string | null }>`SELECT to_regclass('observation.grading_job')::text AS name`.execute(trx);
    if (!job.rows[0]?.name) await sql.raw(gradingJobSql).execute(trx);
  });
}

if (import.meta.main) {
  const url = process.env.OBSERVATION_DATABASE_URL;
  if (!url) throw new Error("OBSERVATION_DATABASE_URL is required");
  const db = openDatabase(url);
  try { await migrateEmptyDatabase(db); }
  finally { await db.destroy(); }
}
