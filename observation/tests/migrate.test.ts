import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "pg";
import { sql } from "kysely";
import { openDatabase } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { readdir } from "node:fs/promises";
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


integration("an incompatible schema is refused instead of adopted", async () => scratch(async (url) => {
  const db = openDatabase(url);
  try {
    await migrateEmptyDatabase(db);
    await sql`UPDATE observation.schema_baseline SET digest = ${"0".repeat(64)}`.execute(db);
    await expect(migrateEmptyDatabase(db)).rejects.toThrow("baseline digest mismatch");
  } finally { await db.destroy(); }
}));

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

interface TableColumns { readonly table_name: string; readonly columns: readonly string[] }
const targetColumns: readonly TableColumns[] = [
  { table_name: "schema_baseline", columns: ["id", "digest", "applied_at"] },
  { table_name: "source_revision", columns: ["producer", "namespace", "revision_id", "run_id", "unit_id", "artifact_kind", "artifact_schema_version", "definition_id", "body", "body_digest", "recorded_at", "captured_at", "predecessor_id", "subject_id"] },
  { table_name: "extractor_definition", columns: ["producer", "namespace", "artifact_kind", "schema_version", "extractor_id", "extractor_version", "item_kind", "item_selector"] },
  { table_name: "logical_item", columns: ["producer", "namespace", "logical_item_id", "run_id", "scope", "producer_local_id"] },
  { table_name: "item_occurrence", columns: ["producer", "namespace", "occurrence_id", "revision_id", "run_id", "artifact_kind", "schema_version", "extractor_id", "extractor_version", "item_kind", "item_selector", "item_id_or_path", "item_scope", "producer_local_id", "selected_value", "logical_item_id", "json_pointer"] },
  { table_name: "item_relation", columns: ["producer", "namespace", "relation_id", "source_occurrence_id", "source_logical_item_id", "target_occurrence_id", "target_logical_item_id", "unresolved_target_ref", "type", "asserted_by", "evidence_ref", "algorithm", "algorithm_version", "recorded_at"] },
  { table_name: "extraction_issue", columns: ["producer", "namespace", "issue_id", "revision_id", "extractor_id", "extractor_version", "item_selector", "kind", "detail", "is_retriable", "recorded_at"] },
  { table_name: "question_definition", columns: ["producer", "namespace", "question_id", "question_version", "item_kind", "response_kind", "allowed_values", "missing_evidence_policy", "abstain_semantics", "unclear_semantics", "interpretation_caveats", "question_text"] },
  { table_name: "evidence_set", columns: ["producer", "namespace", "evidence_set_id", "subject_occurrence_id", "question_id", "question_version", "evidence_refs", "is_incomplete", "incompleteness_reason", "created_at"] },
  { table_name: "evaluator_definition", columns: ["producer", "namespace", "evaluator_definition_id", "kind", "backend_kind", "provider", "model", "prompt_digest", "config_digest", "runtime_revision", "cost_metadata", "seed", "attempt_controls", "identity_digest", "instruction_text"] },
  { table_name: "evaluation_execution", columns: ["producer", "namespace", "execution_id", "subject_occurrence_id", "evidence_set_id", "question_id", "question_version", "evaluator_definition_id", "attempt_label", "idempotency_digest", "run_id", "runner_name", "estimated_cost", "lease_owner", "lease_expires_at", "retry_limit", "next_attempt_at", "created_at", "updated_at", "attempts", "started_at", "ended_at", "status", "error", "model_usage", "cost", "external_execution_id", "provider_link", "reproducibility_metadata"] },
  { table_name: "grading_provider_attempt", columns: ["producer", "namespace", "execution_id", "attempt", "run_id", "request_sent", "outcome", "charged_cost", "admitted_estimate", "cost_overage", "provider_request_id", "failure_category", "created_at", "updated_at"] },
  { table_name: "grade_observation", columns: ["producer", "namespace", "observation_id", "execution_id", "answer_kind", "answer_state", "answer_payload", "probabilities", "confidence", "reviewer_id", "reviewer_details", "comments", "rationale", "quality_flags", "supersedes_observation_id", "recorded_at"] },
  { table_name: "source_event_cursor", columns: ["producer", "namespace", "commit_txid", "event_id"] },
  { table_name: "source_event_outcome", columns: ["producer", "namespace", "event_id", "run_id", "commit_txid", "event_kind", "outcome_kind", "detail", "recorded_at"] },
];

integration("a freshly migrated database has exactly the fifteen target tables and every target column", () => scratch(async (url) => {
  const db = openDatabase(url);
  try {
    await migrateEmptyDatabase(db);
    await migrateEmptyDatabase(db);
    const catalog = await sql<TableColumns>`SELECT table_name, array_agg(column_name::text ORDER BY ordinal_position) AS columns
      FROM information_schema.columns WHERE table_schema = 'observation' GROUP BY table_name ORDER BY table_name`.execute(db);
    expect(catalog.rows).toEqual([...targetColumns].sort((a, b) => a.table_name.localeCompare(b.table_name)));
    const policies = await sql<{ table_name: string; enabled: boolean; forced: boolean; policy: string | null }>`
      SELECT c.relname AS table_name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced, p.polname AS policy
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_policy p ON p.polrelid = c.oid
      WHERE n.nspname = 'observation' AND c.relkind = 'r' AND c.relname <> 'schema_baseline' ORDER BY c.relname`.execute(db);
    expect(policies.rows).toEqual(targetColumns.filter((table) => table.table_name !== "schema_baseline")
      .map(({ table_name }) => ({ table_name, enabled: true, forced: true, policy: `${table_name}_tenant` }))
      .sort((a, b) => a.table_name.localeCompare(b.table_name)));
  } finally { await db.destroy(); }
}));
