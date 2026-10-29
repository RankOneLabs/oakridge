import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { z } from "zod";
import type { CanonicalDigest, EvidenceSetId, ExecutionId, ItemOccurrenceId, QuestionId } from "../src/domain/identity";
import { LangfuseBackend } from "../src/langfuse/backend";
import type { LangfuseConfig } from "../src/langfuse/config";
import { createLangfuseHttpClient, withBoundedRetry } from "../src/langfuse/http-client";
import { mappingKey } from "../src/langfuse/mapping";
import type { ExternalTargetIds, ProjectionInput } from "../src/ports/evaluation-backend";
import { openDatabase, withTenant, type Database } from "../src/storage/database";
import { readLangfuseQuarantine, upsertLangfuseMapping } from "../src/storage/langfuse-store";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { dropScratchDatabase } from "./database-fixture";
import { evaluator } from "./grading-fixture";
import { registerGradingContext } from "../src/storage/grading-store";

const tenant = { producer: "oakridge", namespace: "pilot" };
const config: LangfuseConfig = { base_url: "https://example.langfuse.test", project_id: "project-1",
  credential: { public_key: "public", secret_key: "private" }, annotation_queue_id: "queue-1",
  decision_evaluator_id: "evaluator-1", retry: { max_attempts: 3, backoff_ms: 1 } };
const evidence = { evidence_set_id: "evidence-1" as EvidenceSetId,
  references: [{ ref: "revision:one", kind: "public" as const, content: null, digest: "digest" }],
  is_incomplete: false, incompleteness_reason: null };
const question = { question_id: "pilot.boolean" as QuestionId, question_version: "v1",
  target_item_kinds: ["criterion"], input_recipe: { ref: "revision:one" }, response_kind: "boolean" as const,
  allowed_values: null, missing_evidence_policy: "fail" as const,
  abstain_semantics: "no evidence", unclear_semantics: "ambiguous", interpretation_caveats: "pilot",
  requires_repository_snapshot: false };
const execution = { execution_id: "execution-1" as ExecutionId,
  subject_occurrence_id: "occurrence-1" as ItemOccurrenceId, evidence_set_id: evidence.evidence_set_id,
  question_id: question.question_id, question_version: question.question_version,
  evaluator_definition_id: "eval-1", config_digest: "config", attempt_label: "attempt-1",
  idempotency_digest: "digest", attempts: 1, retries: 0, started_at: new Date(0), ended_at: new Date(1),
  status: "completed" as const, error: null, model_usage: null, cost: null,
  external_execution_id: null, provider_link: null, reproducibility_metadata: null };
const input: ProjectionInput = { execution, evidence, question, question_text: "Does it meet the criterion?",
  source: { producer: "oakridge", namespace: "pilot", run_id: "run-1" as ProjectionInput["source"]["run_id"],
    unit_id: null, artifact_kind: "brief", revision_id: "revision-1" as ProjectionInput["source"]["revision_id"],
    revision_digest: `canonical-json/v1:${"c".repeat(64)}` as CanonicalDigest,
    logical_item_id: null, extractor_version: "v1" },
  policy: { body_sensitivity: { analysis: "restricted", plan: "restricted", brief: "restricted", assessment: "restricted" },
    allow_raw_build_output: false, allow_raw_test_output: false, allow_repository_content: false },
  projection_version: "v1" };

async function scratch(work: (db: Database) => Promise<void>): Promise<void> {
  const serverUrl = process.env.OAKRIDGE_TEST_DATABASE_URL;
  if (!serverUrl) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required");
  const name = `observation_lf_adapter_${randomBytes(6).toString("hex")}`;
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

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;

integration("projection replays one pending mapping and a new attempt stays distinct before Phase A", async () => scratch(async (db) => {
  const requests: string[] = [];
  const transport = async (request: string, init: RequestInit) => {
    requests.push(`${init?.method} ${request}`);
    if (String(request).endsWith("/api/openapi.yaml")) return new Response(`info:\n  version: 4.36.0\npaths:\n  /api/public/v2/evaluators:\n  /api/public/annotation-queues:\n  /api/public/v3/scores:\n  /api/public/v2/evaluation-rules:\n`);
    return Response.json({ data: [] });
  };
  const backend = new LangfuseBackend(db, tenant, config, createLangfuseHttpClient(config, transport));
  const first = await backend.project(input);
  const replay = await backend.project(input);
  const rerun = await backend.project({ ...input, execution: { ...execution,
    execution_id: "execution-2" as ExecutionId, attempt_label: "attempt-2" } });
  expect(first.ok).toBe(false);
  expect(replay.ok).toBe(false);
  expect(rerun.ok).toBe(false);
  const key = mappingKey({ occurrence_id: execution.subject_occurrence_id, evidence,
    question_id: question.question_id, question_version: question.question_version, projection_version: "v1" });
  if (!key.ok) throw new Error(key.error.detail);
  const rows = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.langfuse_mapping").selectAll().execute());
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ occurrence_id: "occurrence-1", sync_state: "pending", trace_id: null,
    evidence_set_digest: key.value.evidence_set_digest });
  expect(rows[0]?.mapping_key).not.toBe(rows[1]?.mapping_key);
  expect(requests.every((request) => request.startsWith("GET"))).toBe(true);
}));

const openapi = `info:\n  version: 4.36.0\npaths:\n  /api/public/v2/evaluators:\n  /api/public/annotation-queues:\n  /api/public/v3/scores:\n  /api/public/v2/evaluation-rules:\n`;

integration("a recorded Phase A run lets projection write one span whose IDs a replay repeats", async () => scratch(async (db) => {
  const posts: { url: string; body: unknown }[] = [];
  const transport = async (request: string, init: RequestInit) => {
    if (init?.method === "POST") { posts.push({ url: request, body: JSON.parse(String(init.body)) }); return Response.json({}); }
    if (String(request).endsWith("/api/openapi.yaml")) return new Response(openapi);
    if (String(request).includes("/v2/evaluation-rules?")) return Response.json({ data: [{ enabled: true,
      evaluatorAssignments: [{ evaluatorId: "evaluator-1", variableMapping: null }] }], meta: {} });
    return Response.json({ data: [] });
  };
  const gated = { ...config, phase_a_trace_id: "a".repeat(32) };
  const backend = new LangfuseBackend(db, tenant, gated, createLangfuseHttpClient(gated, transport));
  const first = await backend.project(input);
  const replay = await backend.project(input);
  if (!first.ok || first.value.status !== "written") throw new Error("projection did not write");
  expect(replay).toEqual(first);
  expect(posts.map((post) => post.url)).toEqual([`${config.base_url}/api/public/otel/v1/traces`,
    `${config.base_url}/api/public/otel/v1/traces`]);
  const span = (posts[0]?.body as { resourceSpans: { scopeSpans: { spans: { traceId: string; spanId: string; name: string }[] }[] }[] })
    .resourceSpans[0]?.scopeSpans[0]?.spans[0];
  expect(span).toMatchObject({ traceId: first.value.trace_id, spanId: first.value.observation_id, name: "pilot.boolean@v1" });
  const rows = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.langfuse_mapping").selectAll().execute());
  expect(rows.map((row) => [row.sync_state, row.trace_id])).toEqual([["pending", null]]);
}));

integration("an annotation is read under its score-config name; the projection-score name is quarantined", async () => scratch(async (db) => {
  const digest = mappingKey({ occurrence_id: execution.subject_occurrence_id, evidence,
    question_id: question.question_id, question_version: question.question_version, projection_version: "v1" });
  if (!digest.ok) throw new Error(digest.error.detail);
  const ids = { trace_id: "trace-1", observation_id: "observation-1", score_id: "score-1",
    queue_item_id: "queue-item-1" } as ExternalTargetIds;
  const mapping = await upsertLangfuseMapping(db, tenant, { base_mapping_key: digest.value.mapping_key,
    occurrence_id: execution.subject_occurrence_id, evidence_set_id: evidence.evidence_set_id,
    evidence_set_digest: digest.value.evidence_set_digest, question_id: question.question_id,
    question_version: question.question_version, projection_version: "v1",
    execution_id: execution.execution_id, attempt_id: execution.attempt_label, external_ids: ids });
  if (!mapping.ok) throw new Error(mapping.error.detail);
  const registered = await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("human") });
  if (!registered.ok) throw new Error("question was not registered");
  const annotation = (name: string) => ({ id: `annotation-${name}`, projectId: config.project_id, name, value: true,
    dataType: "BOOLEAN", source: "ANNOTATION", updatedAt: new Date().toISOString(), queueId: "queue-1",
    authorUserId: "reviewer-1", metadata: null,
    subject: { kind: "observation", id: ids.observation_id, traceId: ids.trace_id } });
  const transport = async (url: string): Promise<Response> => url.includes("source=ANNOTATION")
    ? Response.json({ data: [annotation("pilot.boolean@v1"), annotation("pilot.boolean.v1")] })
    : url.includes("/v3/scores") ? Response.json({ data: [] })
      : Response.json({ id: ids.queue_item_id, queueId: "queue-1", objectId: ids.observation_id,
        objectType: "OBSERVATION", status: "COMPLETED", completedAt: new Date().toISOString() });
  const backend = new LangfuseBackend(db, tenant, config, createLangfuseHttpClient(config, transport));
  const inbound = await backend.fetch({ mapping_key: mapping.value.mapping_key as CanonicalDigest, external_ids: ids });
  expect(inbound).toMatchObject({ ok: true, value: { annotation_outcomes: [{ status: "completed",
    score_id: "annotation-pilot.boolean.v1", value: true }] } });
  const quarantine = await readLangfuseQuarantine(db, tenant);
  expect(quarantine.ok && quarantine.value.map((row) => row.score_id)).toEqual(["annotation-pilot.boolean@v1"]);
}));

test("transient HTTP failures retry with bounded exponential backoff and no credential disclosure", async () => {
  let attempts = 0;
  const waits: number[] = [];
  const client = createLangfuseHttpClient(config, async () => { attempts++; return new Response("", { status: 503 }); });
  const result = await withBoundedRetry(() => client.request({ operation: "probe", entity_id: "target",
    method: "GET", path: "/api/public/v3/scores?limit=1", response: questionSchema }), config.retry,
    async (ms) => { waits.push(ms); });
  expect(result).toMatchObject({ ok: false, error: { status: 503, is_transient: true } });
  expect([attempts, waits]).toEqual([3, [1, 2]]);
  expect(JSON.stringify(result)).not.toContain(config.credential.secret_key);
});

integration("unmapped score returned by HTTP is quarantined and creates no local grade", async () => scratch(async (db) => {
  const digest = mappingKey({ occurrence_id: execution.subject_occurrence_id, evidence,
    question_id: question.question_id, question_version: question.question_version, projection_version: "v1" });
  if (!digest.ok) throw new Error(digest.error.detail);
  const ids = { trace_id: "trace-1", observation_id: "observation-1", score_id: "score-1",
    queue_item_id: "queue-item-1" } as ExternalTargetIds;
  const mapping = await upsertLangfuseMapping(db, tenant, { base_mapping_key: digest.value.mapping_key,
    occurrence_id: execution.subject_occurrence_id, evidence_set_id: evidence.evidence_set_id,
    evidence_set_digest: digest.value.evidence_set_digest, question_id: question.question_id,
    question_version: question.question_version, projection_version: "v1",
    execution_id: execution.execution_id, attempt_id: execution.attempt_label, external_ids: ids });
  if (!mapping.ok) throw new Error(mapping.error.detail);
  const remote = { id: "unmapped-score", projectId: config.project_id, name: "pilot.boolean@v1", value: true,
    dataType: "BOOLEAN", source: "API", updatedAt: new Date().toISOString(),
    subject: { kind: "observation", id: ids.observation_id, traceId: ids.trace_id } };
  const malformed = { ...remote, id: "malformed-score", value: { nested: true } };
  const transport = async (url: string): Promise<Response> => url.includes("/v3/scores")
    ? Response.json({ data: [remote, malformed] }) : Response.json({ id: ids.queue_item_id, queueId: "queue-1",
      objectId: ids.observation_id, objectType: "OBSERVATION", status: "PENDING" });
  const backend = new LangfuseBackend(db, tenant, config, createLangfuseHttpClient(config, transport));
  const inbound = await backend.fetch({ mapping_key: mapping.value.mapping_key as CanonicalDigest, external_ids: ids });
  expect(inbound).toMatchObject({ ok: true, value: { scores: [] } });
  const quarantine = await readLangfuseQuarantine(db, tenant);
  expect(quarantine.ok && quarantine.value.length).toBe(2);
  const grades = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.grade_observation").selectAll().execute());
  expect(grades).toHaveLength(0);
}));

const questionSchema = z.object({ data: z.array(z.object({ id: z.string() })) });
