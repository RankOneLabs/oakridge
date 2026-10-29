import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { sql } from "kysely";
import type { CanonicalDigest, EvidenceSetId, ExecutionId, ItemOccurrenceId, QuestionId } from "../src/domain/identity";
import type { ExternalTargetIds, LangfuseObservationId, LangfuseScoreId } from "../src/ports/evaluation-backend";
import { openDatabase, withTenant, type Database } from "../src/storage/database";
import { mappingKeyForAttempt, placeLangfuseInboundScore, readLangfuseQuarantine,
  readLangfuseTransitions, transitionLangfuseMapping, upsertLangfuseMapping,
  type LangfuseMappingInput } from "../src/storage/langfuse-store";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { dropScratchDatabase } from "./database-fixture";

const serverUrl = process.env.OAKRIDGE_TEST_DATABASE_URL;
const integration = serverUrl || process.env.CI === "true" ? test : test.skip;
const tenant = { producer: "oakridge", namespace: "langfuse-test" };
const key = `canonical-json/v1:${"a".repeat(64)}` as CanonicalDigest;
const evidenceDigest = `canonical-json/v1:${"b".repeat(64)}` as CanonicalDigest;
const externalIds = { trace_id: "trace-verbatim", observation_id: "observation-verbatim",
  score_id: "score-verbatim", queue_item_id: "queue-verbatim" } as ExternalTargetIds;

function mapping(attempt_id: string, execution_id: string): LangfuseMappingInput {
  return { base_mapping_key: key, occurrence_id: "occurrence-1" as ItemOccurrenceId,
    evidence_set_id: "evidence-1" as EvidenceSetId, evidence_set_digest: evidenceDigest,
    question_id: "question-1" as QuestionId, question_version: "1", projection_version: "1",
    execution_id: execution_id as ExecutionId, attempt_id, external_ids: externalIds };
}

async function scratch(work: (db: Database) => Promise<void>): Promise<void> {
  if (!serverUrl) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required");
  const name = `observation_langfuse_${randomBytes(6).toString("hex")}`;
  const admin = new Client({ connectionString: serverUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(serverUrl); url.pathname = `/${name}`;
    const db = openDatabase(url.href);
    try { await migrateEmptyDatabase(db); await work(db); }
    finally { await db.destroy(); await dropScratchDatabase(admin, name); }
  } finally { await admin.end(); }
}

integration("sync replay retains one mapping and exact external IDs while a new attempt stays distinct", async () => scratch(async (db) => {
  const first = await upsertLangfuseMapping(db, tenant, mapping("attempt-1", "execution-1"));
  const replay = await upsertLangfuseMapping(db, tenant, mapping("attempt-1", "execution-1"));
  const rerun = await upsertLangfuseMapping(db, tenant, mapping("attempt-2", "execution-2"));
  expect(first.ok && replay.ok && rerun.ok).toBe(true);
  if (!first.ok || !replay.ok || !rerun.ok) return;
  const expectedKey = mappingKeyForAttempt(key, "attempt-1");
  expect(expectedKey.ok).toBe(true);
  if (!expectedKey.ok) return;
  expect(String(expectedKey.value)).toBe(first.value.mapping_key);
  expect(replay.value.mapping_key).toBe(first.value.mapping_key);
  expect(rerun.value.mapping_key).not.toBe(first.value.mapping_key);
  const rows = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.langfuse_mapping").selectAll().orderBy("attempt_id").execute());
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => [row.attempt_id, row.execution_id])).toEqual([
    ["attempt-1", "execution-1"], ["attempt-2", "execution-2"]]);
  expect(rows.map((row) => [row.trace_id, row.observation_id, row.score_id, row.queue_item_id])).toEqual([
    Object.values(externalIds), Object.values(externalIds)]);
  const conflicting = await upsertLangfuseMapping(db, tenant, { ...mapping("attempt-1", "execution-1"),
    external_ids: { ...externalIds, score_id: "different" as LangfuseScoreId } });
  expect(conflicting.ok).toBe(false);
  const matched = await placeLangfuseInboundScore(db, tenant, { mapping_key: expectedKey.value,
    score_id: externalIds.score_id, observation_id: externalIds.observation_id, raw_payload: { value: 1 } });
  expect(matched.ok && matched.value.status).toBe("mapped");
  const mismatched = await placeLangfuseInboundScore(db, tenant, { mapping_key: expectedKey.value,
    score_id: "wrong-score" as LangfuseScoreId, observation_id: externalIds.observation_id, raw_payload: { value: 2 } });
  expect(mismatched.ok && mismatched.value.status).toBe("quarantined");
  await expect(withTenant(db, tenant, (trx) => trx.updateTable("observation.langfuse_mapping")
    .set({ occurrence_id: "other" }).where("mapping_key", "=", first.value.mapping_key).execute())).rejects.toThrow("immutable");
}));

integration("unmatched inbound score is quarantined with its raw payload and creates no local grade", async () => scratch(async (db) => {
  const raw = { score: { id: "orphan-score", value: 0.7 }, source: "langfuse" };
  const result = await placeLangfuseInboundScore(db, tenant, { mapping_key: null,
    score_id: "orphan-score" as LangfuseScoreId, observation_id: "unknown-observation" as LangfuseObservationId,
    raw_payload: raw });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value.status).toBe("quarantined");
  const rows = await readLangfuseQuarantine(db, tenant);
  expect(rows.ok).toBe(true);
  if (!rows.ok) return;
  expect(rows.value.map((row) => [row.raw_payload, row.reason, row.sync_state])).toEqual([
    [raw, "no authenticated mapping for score and observation", "unmatched"] ]);
  const counts = await withTenant(db, tenant, (trx) => sql<{ grades: string; executions: string }>`
    SELECT (SELECT count(*)::text FROM observation.grade_observation) AS grades,
      (SELECT count(*)::text FROM observation.evaluation_execution) AS executions`.execute(trx));
  expect(counts.rows[0]).toEqual({ grades: "0", executions: "0" });
}));

integration("completed and timed-out sync paths retain every transition without grading writes", async () => scratch(async (db) => {
  const inserted = await upsertLangfuseMapping(db, tenant, mapping("attempt-1", "execution-1"));
  expect(inserted.ok).toBe(true);
  if (!inserted.ok) return;
  for (const state of ["pending", "completed"] as const) {
    const result = await transitionLangfuseMapping(db, tenant, inserted.value.mapping_key as CanonicalDigest, state);
    expect(result.ok).toBe(true);
  }
  const transitions = await readLangfuseTransitions(db, tenant, inserted.value.mapping_key as CanonicalDigest);
  expect(transitions.ok).toBe(true);
  if (!transitions.ok) return;
  expect(transitions.value.map((row) => [row.from_state, row.to_state])).toEqual([
    [null, "queued"], ["queued", "pending"], ["pending", "completed"] ]);
  const timedOut = await upsertLangfuseMapping(db, tenant, mapping("attempt-2", "execution-2"));
  expect(timedOut.ok).toBe(true);
  if (!timedOut.ok) return;
  for (const state of ["pending", "timed_out", "stale"] as const) {
    const result = await transitionLangfuseMapping(db, tenant, timedOut.value.mapping_key as CanonicalDigest, state);
    expect(result.ok).toBe(true);
  }
  const timedOutTransitions = await readLangfuseTransitions(db, tenant, timedOut.value.mapping_key as CanonicalDigest);
  expect(timedOutTransitions.ok).toBe(true);
  if (!timedOutTransitions.ok) return;
  expect(timedOutTransitions.value.map((row) => [row.from_state, row.to_state])).toEqual([
    [null, "queued"], ["queued", "pending"], ["pending", "timed_out"], ["timed_out", "stale"] ]);
  const executions = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluation_execution").selectAll().execute());
  expect(executions).toHaveLength(0);
  await expect(withTenant(db, tenant, (trx) => trx.updateTable("observation.langfuse_sync_transition")
    .set({ to_state: "failed" }).where("transition_id", "=", transitions.value[0]!.transition_id).execute())).rejects.toThrow("append-only");
}));

integration("all new tables enforce tenant row security for reads and writes", async () => scratch(async (db) => {
  const role = `observation_langfuse_reader_${randomBytes(6).toString("hex")}`;
  await sql.raw(`CREATE ROLE ${role} NOLOGIN`).execute(db);
  try {
    await sql.raw(`GRANT USAGE ON SCHEMA observation TO ${role}`).execute(db);
    for (const table of ["langfuse_mapping", "langfuse_sync_transition", "langfuse_inbound_quarantine"])
      await sql.raw(`GRANT SELECT, INSERT ON observation.${table} TO ${role}`).execute(db);
    const inserted = await upsertLangfuseMapping(db, tenant, mapping("attempt-1", "execution-1"));
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    const crossTenant = async (table: string, columns: string, values: string) => db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('observation.producer', ${tenant.producer}, true),
        set_config('observation.namespace', ${tenant.namespace}, true)`.execute(trx);
      await sql.raw(`SET LOCAL ROLE ${role}`).execute(trx);
      await sql.raw(`INSERT INTO observation.${table} (producer, namespace, ${columns}) VALUES ('oakridge', 'other', ${values})`).execute(trx);
    });
    await expect(crossTenant("langfuse_mapping",
      "mapping_key, occurrence_id, evidence_set_id, evidence_set_digest, question_id, question_version, projection_version, execution_id, attempt_id, sync_state",
      `'${key}', 'o', 'e', '${evidenceDigest}', 'q', '1', '1', 'x', 'a', 'queued'`)).rejects.toThrow("row-level security");
    await expect(crossTenant("langfuse_sync_transition", "mapping_key, to_state",
      `'${inserted.value.mapping_key}', 'pending'`)).rejects.toThrow("row-level security");
    await expect(crossTenant("langfuse_inbound_quarantine", "sync_state, raw_payload, reason",
      "'unmatched', '{}'::jsonb, 'unmatched'")).rejects.toThrow("row-level security");
    const hidden = await db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('observation.producer', 'oakridge', true), set_config('observation.namespace', 'other', true)`.execute(trx);
      await sql.raw(`SET LOCAL ROLE ${role}`).execute(trx);
      return Promise.all(["langfuse_mapping", "langfuse_sync_transition", "langfuse_inbound_quarantine"].map(async (table) => {
        const result = await sql.raw<{ count: string }>(`SELECT count(*)::text AS count FROM observation.${table}`).execute(trx);
        return result.rows[0]?.count;
      }));
    });
    expect(hidden).toEqual(["0", "0", "0"]);
  } finally {
    await sql.raw(`DROP OWNED BY ${role}`).execute(db);
    await sql.raw(`DROP ROLE ${role}`).execute(db);
  }
}));
