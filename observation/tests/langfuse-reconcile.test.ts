import { instructionDigest } from "../src/grading/evaluator";
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { canonicalDigest } from "../src/canonical/canonical-json";
import type { JsonValue } from "../src/domain/primitives";
import { createApp } from "../src/http/app";
import type { CanonicalDigest, EvidenceSetId, ExecutionId, ItemOccurrenceId, QuestionId } from "../src/domain/identity";
import { detectLangfuseFeatures, requireLangfuseCapability } from "../src/langfuse/feature-detection";
import { createLangfuseHttpClient } from "../src/langfuse/http-client";
import type { LangfuseConfig } from "../src/langfuse/config";
import { LangfuseBackend } from "../src/langfuse/backend";
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
integration("reconcile reads an authenticated HTTP score once and preserves an existing grade", async () => {
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
      const credentials = { ingest: [{ ...tenant, token: "ingest" }], read: [{ ...tenant, token: "read" }],
        grade: [{ ...tenant, token: "grade" }] };
      const app = createApp({ db, credentials });
      const body = await Bun.file(new URL("../fixtures/oakridge/run-slice/plan-revision.json", import.meta.url)).json() as JsonValue;
      const bodyDigest = canonicalDigest(body);
      if (!bodyDigest.ok) throw new Error(bodyDigest.error.detail);
      const ingested = await app.request("/v1/sources/oakridge/sync", { method: "POST", headers: {
        authorization: "Bearer ingest", "idempotency-key": "reconcile-plan", "content-type": "application/json" },
        body: JSON.stringify({ format: "observation.artifact-revision/v1", source: { ...tenant,
          revision_id: "oakridge:pilot:reconcile-plan", run_id: "run-reconcile", unit_id: "run-reconcile/planning",
          artifact_kind: "plan", artifact_schema_version: "development-v1",
          definition_bundle: { id: "development", digest: "fixture-bundle" } },
          recorded_at: "2026-10-28T10:00:00.000Z", body, body_digest: bodyDigest.value }) });
      expect(ingested.status).toBe(201);
      const items = await app.request("/v1/runs/run-reconcile/items", { headers: { authorization: "Bearer read" } });
      const selected = (await items.json() as { items: { occurrence_id: string; item_kind: string }[] }).items
        .find((item) => item.item_kind === "criterion");
      if (!selected) throw new Error("fixture criterion not projected");
      const question_id = "pilot.boolean" as QuestionId;
      const evidence_set_id = "evidence-1" as EvidenceSetId;
      const evaluated = await app.request("/v1/evaluations", { method: "POST", headers: {
        authorization: "Bearer grade", "content-type": "application/json" }, body: JSON.stringify({
        identity: { subject_occurrence_id: selected.occurrence_id, evidence_set_id,
          question_id, question_version: "v1", evaluator_definition_id: "eval-1",
          config_digest: "config", attempt_label: "attempt-1" },
        context: { question: { question_id, question_version: "v1", target_item_kinds: ["criterion"],
          input_recipe: { expected: "fixture" }, response_kind: "boolean", allowed_values: null,
          missing_evidence_policy: "fail", abstain_semantics: "insufficient", unclear_semantics: "ambiguous",
          interpretation_caveats: "reconcile test", requires_repository_snapshot: false },
          evidence: { evidence_set_id, references: [], is_incomplete: false, incompleteness_reason: null },
          evaluator: { evaluator_definition_id: "eval-1", kind: "model", backend_kind: "local",
            provider: "fixture", model: "pinned", instruction_text: "fixture", prompt_digest: instructionDigest("fixture"), config_digest: "config",
            runtime_revision: "1", cost_metadata: null, seed: null,
            attempt_controls: { answer: { state: "answered", kind: "boolean", value: true } } } },
        runner: "stub_model" }) });
      expect(evaluated.status).toBe(201);
      const local = await evaluated.json() as { execution: { execution_id: string };
        observation: { observation_id: string } };
      const base = `canonical-json/v1:${"a".repeat(64)}` as CanonicalDigest;
      const ids = { trace_id: "trace-1", observation_id: "observation-1", score_id: "score-1",
        queue_item_id: "queue-1" } as ExternalTargetIds;
      const mapped = await upsertLangfuseMapping(db, tenant, { base_mapping_key: base,
        occurrence_id: selected.occurrence_id as ItemOccurrenceId, evidence_set_id,
        evidence_set_digest: `canonical-json/v1:${"b".repeat(64)}` as CanonicalDigest,
        question_id, question_version: "v1", projection_version: "v1",
        execution_id: local.execution.execution_id as ExecutionId, attempt_id: "attempt-1", external_ids: ids });
      if (!mapped.ok) throw new Error(mapped.error.detail);
      const key = mapped.value.mapping_key as CanonicalDigest;
      await transitionLangfuseMapping(db, tenant, key, "pending");
      const selector = { mapping_key: key, occurrence_id: selected.occurrence_id as ItemOccurrenceId,
        question_id, question_version: "v1", external_ids: ids };
      let reads = 0;
      const client = createLangfuseHttpClient(config, async () => { reads++; return Response.json({ data: [{
        id: ids.score_id, projectId: config.project_id, name: "pilot.boolean@v1", value: true,
        dataType: "BOOLEAN", source: "EVAL", updatedAt: new Date().toISOString(),
        subject: { kind: "observation", id: ids.observation_id, traceId: ids.trace_id },
        metadata: { mapping_key: key, evaluator_definition_id: "eval-1", model: "pinned", grader_source: "EVAL" },
      }] }); });
      const backend = new LangfuseBackend(db, tenant, config, client);
      const first = await backend.reconcile(selector);
      const replay = await backend.reconcile(selector);
      expect(first).toMatchObject({ ok: true, value: { sync_state: { status: "completed" } } });
      expect(replay).toMatchObject({ ok: true, value: { sync_state: { status: "completed" } } });
      expect(reads).toBe(1);
      const grades = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.grade_observation").selectAll().execute());
      expect(grades.map((grade) => grade.observation_id)).toEqual([local.observation.observation_id]);
    } finally { await db.destroy(); await dropScratchDatabase(admin, name); }
  } finally { await admin.end(); }
});
