import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalDigest, ExecutionId } from "../src/domain/identity";
import { createApp } from "../src/http/app";
import type { ExternalTargetIds } from "../src/ports/evaluation-backend";
import { LangfuseBackend } from "../src/langfuse/backend";
import type { LangfuseConfig } from "../src/langfuse/config";
import { createLangfuseHttpClient } from "../src/langfuse/http-client";
import { mappingKey } from "../src/langfuse/mapping";
import { deterministicChecker } from "../src/runners/deterministic-checker";
import { listGrades, registerGradingContext, runGrade } from "../src/storage/grading-store";
import { upsertLangfuseMapping } from "../src/storage/langfuse-store";
import { withTenant } from "../src/storage/database";
import { tenant, question, evidence, evaluator, scratchGrading } from "./grading-fixture";

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
const config: LangfuseConfig = { base_url: "https://langfuse.example.test", project_id: "pilot-project",
  credential: { public_key: "public", secret_key: "test-secret" }, annotation_queue_id: null,
  decision_evaluator_id: null, retry: { max_attempts: 1, backoff_ms: 0 } };

integration("temporary Langfuse outage leaves local grade readable and replay creates no second target or grade", async () =>
  scratchGrading(async (db, occurrence_id) => {
    const context = { question: { ...question, input_recipe: { expected: "sample" } }, evidence,
      evaluator: evaluator("code") };
    const registered = await registerGradingContext(db, tenant, context);
    if (!registered.ok) throw new Error(registered.error.detail);
    const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
      question_id: question.question_id, question_version: question.question_version,
      evaluator_definition_id: "code", config_digest: "config-1", attempt_label: "pilot-attempt-1" };
    const grade = await runGrade(db, tenant, { identity, runner: deterministicChecker });
    if (!grade.ok || !grade.value.observation) throw new Error("local grade was not stored");
    const before = await listGrades(db, tenant, occurrence_id, { limit: 10, offset: 0 });
    const digest = mappingKey({ occurrence_id, evidence, question_id: question.question_id,
      question_version: question.question_version, projection_version: "v1" });
    if (!digest.ok) throw new Error(digest.error.detail);
    const ids = { trace_id: "trace-1", observation_id: "remote-observation-1", score_id: "remote-score-1",
      queue_item_id: "remote-queue-item-1" } as ExternalTargetIds;
    const mapping_input = { base_mapping_key: digest.value.mapping_key, occurrence_id,
      evidence_set_id: evidence.evidence_set_id, evidence_set_digest: digest.value.evidence_set_digest,
      question_id: question.question_id, question_version: question.question_version, projection_version: "v1",
      execution_id: grade.value.execution.execution_id as ExecutionId, attempt_id: identity.attempt_label, external_ids: ids };
    const mapping = await upsertLangfuseMapping(db, tenant, mapping_input);
    if (!mapping.ok) throw new Error(mapping.error.detail);
    const selector = { mapping_key: mapping.value.mapping_key as CanonicalDigest, occurrence_id,
      question_id: question.question_id, question_version: question.question_version, external_ids: ids };
    let is_outage = true;
    let remote_reads = 0;
    const client = createLangfuseHttpClient(config, async () => {
      remote_reads++;
      return is_outage ? new Response("", { status: 503 }) : Response.json({ data: [{
        id: ids.score_id, projectId: config.project_id, name: `${question.question_id}@${question.question_version}`,
        value: true, dataType: "BOOLEAN", source: "API", updatedAt: new Date().toISOString(),
        subject: { kind: "observation", id: ids.observation_id, traceId: ids.trace_id },
        metadata: { mapping_key: mapping.value.mapping_key, evaluator_definition_id: "code",
          model: null, grader_source: "API" },
      }] });
    });
    const backend = new LangfuseBackend(db, tenant, config, client);
    const unavailable = await backend.reconcile(selector);
    expect(unavailable).toMatchObject({ ok: false, error: { status: 503 } });
    const during = await listGrades(db, tenant, occurrence_id, { limit: 10, offset: 0 });
    expect(during?.items.map((item) => item.observation.observation_id))
      .toEqual(before?.items.map((item) => item.observation.observation_id));
    is_outage = false;
    const replayed_mapping = await upsertLangfuseMapping(db, tenant, mapping_input);
    expect(replayed_mapping.ok && replayed_mapping.value.mapping_key).toBe(mapping.value.mapping_key);
    const recovered = await backend.reconcile(selector);
    const replay = await backend.reconcile(selector);
    expect(recovered).toMatchObject({ ok: true, value: { sync_state: { status: "completed" } } });
    expect(replay).toMatchObject({ ok: true, value: { sync_state: { status: "completed" } } });
    expect(remote_reads).toBe(2);
    const after = await listGrades(db, tenant, occurrence_id, { limit: 10, offset: 0 });
    expect(after?.items.map((item) => item.observation.observation_id))
      .toEqual(before?.items.map((item) => item.observation.observation_id));
    const mappings = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.langfuse_mapping")
      .selectAll().execute());
    expect(mappings).toHaveLength(1);
    expect(mappings[0]).toMatchObject({ trace_id: ids.trace_id, observation_id: ids.observation_id,
      score_id: ids.score_id });
  }));

integration("disabled adapter leaves external grading route, raw grades and Assay export available", async () =>
  scratchGrading(async (db, occurrence_id) => {
    const directory = await mkdtemp(join(tmpdir(), "observation-lf-disable-"));
    try {
      const app = createApp({ db, credentials: { ingest: [{ ...tenant, token: "ingest" }],
        read: [{ ...tenant, token: "read" }], grade: [{ ...tenant, token: "grade" }] },
        langfuse: { status: "disabled" }, exportRoot: directory });
      const evaluated = await app.request("/v1/evaluations", { method: "POST", headers: {
        authorization: "Bearer grade", "content-type": "application/json" }, body: JSON.stringify({
        identity: { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
          question_id: question.question_id, question_version: question.question_version,
          evaluator_definition_id: "code", config_digest: "config-1", attempt_label: "disabled-drill" },
        context: { question: { ...question, input_recipe: { expected: "sample" } }, evidence,
          evaluator: evaluator("code") }, runner: "deterministic" }) });
      expect(evaluated.status).toBe(201);
      const grades = await app.request(`/v1/items/${encodeURIComponent(occurrence_id)}/grades`, {
        headers: { authorization: "Bearer read" } });
      expect(grades.status).toBe(200);
      expect((await grades.json() as { total: number }).total).toBe(1);
      const exported = await app.request("/v1/exports/assay", { method: "POST", headers: {
        authorization: "Bearer read", "content-type": "application/json" }, body: JSON.stringify({
        selection: { occurrence_ids: [occurrence_id] } }) });
      expect(exported.status).toBe(201);
      const manifest = (await exported.json() as { manifest: { membership: { disposition: string }[] } }).manifest;
      expect(manifest.membership.some((member) => member.disposition === "included")).toBe(true);
      const disabled = await app.request("/v1/langfuse/status", { headers: { authorization: "Bearer read" } });
      expect(disabled.status).toBe(404);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }));
