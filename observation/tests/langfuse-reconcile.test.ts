import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import type { CanonicalDigest, EvidenceSetId, ExecutionId, ItemOccurrenceId, QuestionId } from "../src/domain/identity";
import { detectLangfuseFeatures, requireLangfuseCapability } from "../src/langfuse/feature-detection";
import { createLangfuseHttpClient } from "../src/langfuse/http-client";
import type { LangfuseConfig } from "../src/langfuse/config";
import { reconcileLangfuseMapping } from "../src/langfuse/reconcile";
import type { ExternalTargetIds } from "../src/ports/evaluation-backend";
import { openDatabase, withTenant } from "../src/storage/database";
import { transitionLangfuseMapping, upsertLangfuseMapping } from "../src/storage/langfuse-store";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { dropScratchDatabase } from "./database-fixture";

const config: LangfuseConfig = { base_url: "https://example.langfuse.test", project_id: "project",
  credential: { public_key: "public", secret_key: "secret" }, annotation_queue_id: null,
  decision_evaluator_id: null, retry: { max_attempts: 2, backoff_ms: 0 } };

test("an unavailable decision-model evaluator is a typed capability failure", async () => {
  const client = createLangfuseHttpClient(config, async (request) => String(request).endsWith("/api/openapi.yaml")
    ? new Response("info:\n  version: 4.36.0\npaths:\n  /api/public/v2/evaluators:\n  /api/public/annotation-queues:\n  /api/public/v3/scores:\n  /api/public/v2/evaluation-rules:\n")
    : Response.json({ data: [] }));
  const report = await detectLangfuseFeatures(client, config);
  if (!report.ok) throw new Error(report.error.detail);
  expect(report.value.openapi_version).toBe("4.36.0");
  expect(requireLangfuseCapability(report.value, "decision_model_evaluators"))
    .toMatchObject({ ok: false, error: { capability: "decision_model_evaluators" } });
});

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
integration("reconcile completes a pending mapping once without writing a grade", async () => {
  const serverUrl = process.env.OAKRIDGE_TEST_DATABASE_URL!;
  const name = `observation_lf_reconcile_${randomBytes(6).toString("hex")}`;
  const admin = new Client({ connectionString: serverUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(serverUrl); url.pathname = `/${name}`;
    const db = openDatabase(url.href);
    try {
      await migrateEmptyDatabase(db);
      const tenant = { producer: "oakridge", namespace: "pilot" };
      const base = `canonical-json/v1:${"a".repeat(64)}` as CanonicalDigest;
      const ids = { trace_id: "trace-1", observation_id: "observation-1", score_id: "score-1",
        queue_item_id: "queue-1" } as ExternalTargetIds;
      const mapped = await upsertLangfuseMapping(db, tenant, { base_mapping_key: base,
        occurrence_id: "occurrence-1" as ItemOccurrenceId, evidence_set_id: "evidence-1" as EvidenceSetId,
        evidence_set_digest: `canonical-json/v1:${"b".repeat(64)}` as CanonicalDigest,
        question_id: "question-1" as QuestionId, question_version: "v1", projection_version: "v1",
        execution_id: "execution-1" as ExecutionId, attempt_id: "attempt-1", external_ids: ids });
      if (!mapped.ok) throw new Error(mapped.error.detail);
      const key = mapped.value.mapping_key as CanonicalDigest;
      await transitionLangfuseMapping(db, tenant, key, "pending");
      const selector = { mapping_key: key, occurrence_id: "occurrence-1" as ItemOccurrenceId,
        question_id: "question-1" as QuestionId, question_version: "v1", external_ids: ids };
      let reads = 0;
      const read = async () => { reads++; return { ok: true as const, value: { scores: [{
        score_id: ids.score_id, observation_id: ids.observation_id, name: "question-1@v1",
        value: true, comment: null, updated_at: new Date().toISOString() }], annotation_outcomes: [] } }; };
      const first = await reconcileLangfuseMapping(db, tenant, selector, read);
      const replay = await reconcileLangfuseMapping(db, tenant, selector, read);
      expect(first).toMatchObject({ ok: true, value: { sync_state: { status: "completed" } } });
      expect(replay).toMatchObject({ ok: true, value: { sync_state: { status: "completed" } } });
      expect(reads).toBe(1);
      const grades = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.grade_observation").selectAll().execute());
      expect(grades).toHaveLength(0);
    } finally { await db.destroy(); await dropScratchDatabase(admin, name); }
  } finally { await admin.end(); }
});
