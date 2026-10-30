import { instructionDigest } from "../src/grading/evaluator";
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { canonicalDigest } from "../src/canonical/canonical-json";
import type { JsonValue } from "../src/domain/primitives";
import { createApp } from "../src/http/app";
import { langfuseConfigFromEnv } from "../src/langfuse/config";
import { LANGFUSE_PILOT_QUESTIONS } from "../src/grading/catalogue/langfuse-pilot";
import type { EvidenceSet } from "../src/grading/evidence";
import type { EvaluatorDefinition } from "../src/grading/evaluator";
import type { ItemOccurrenceId } from "../src/domain/identity";
import { openDatabase, type Database } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { isNetworkRunner, runPilot, type PilotRunner, type PilotRunPlan } from "../scripts/langfuse-pilot-run";
import { dropScratchDatabase } from "./database-fixture";

const tenant = { producer: "oakridge", namespace: "langfuse-offline" };
const credentials = { ingest: [{ ...tenant, token: "ingest-token" }],
  read: [{ ...tenant, token: "read-token" }], grade: [{ ...tenant, token: "grade-token", reviewer_id: "offline-operator" }], export_raw: [] };

async function scratch(work: (db: Database) => Promise<void>): Promise<void> {
  const serverUrl = process.env.OAKRIDGE_TEST_DATABASE_URL;
  if (!serverUrl) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required");
  const name = `observation_lf_offline_${randomBytes(6).toString("hex")}`;
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
integration("missing configuration preserves ingest, projection, lineage and grade reads while sync routes are absent", async () => scratch(async (db) => {
  const configuration = langfuseConfigFromEnv({});
  expect(configuration).toEqual({ ok: true, value: { status: "disabled" } });
  if (!configuration.ok) return;
  const app = createApp({ db, langfuse: configuration.value, credentials });
  const body = await Bun.file(new URL("../fixtures/oakridge/run-slice/plan-revision.json", import.meta.url)).json() as JsonValue;
  const digest = canonicalDigest(body);
  if (!digest.ok) throw new Error(digest.error.detail);
  const ingest = await app.request("/v1/sources/oakridge/sync", { method: "POST", headers: {
    authorization: "Bearer ingest-token", "idempotency-key": "offline-plan", "content-type": "application/json" },
    body: JSON.stringify({ format: "observation.artifact-revision/v1", source: { ...tenant,
      revision_id: `${tenant.producer}:${tenant.namespace}:plan-1`, run_id: "run-offline",
      unit_id: "run-offline/planning", artifact_kind: "plan", artifact_schema_version: "development-v1",
      definition_bundle: { id: "development", digest: "fixture-bundle" } },
      recorded_at: "2026-10-28T10:00:00.000Z", body, body_digest: digest.value }) });
  expect(ingest.status).toBe(201);
  const items = await app.request("/v1/runs/run-offline/items", { headers: { authorization: "Bearer read-token" } });
  expect(items.status).toBe(200);
  const projected = await items.json() as { items: { occurrence_id: string; item_kind: string }[] };
  const criterion = projected.items.find((item) => item.item_kind === "criterion");
  expect(criterion).toBeDefined();
  if (!criterion) return;
  const lineage = await app.request(`/v1/items/${encodeURIComponent(criterion.occurrence_id)}/lineage`,
    { headers: { authorization: "Bearer read-token" } });
  expect(lineage.status).toBe(200);
  const grade = await app.request("/v1/grades", { method: "POST", headers: {
    authorization: "Bearer grade-token", "content-type": "application/json" }, body: JSON.stringify({
    identity: { subject_occurrence_id: criterion.occurrence_id, evidence_set_id: "offline-evidence",
      question_id: "offline-check", question_version: "1", evaluator_definition_id: "offline-human",
      config_digest: "offline-config", attempt_label: "first" },
    context: { question: { question_id: "offline-check", question_version: "1", target_item_kinds: ["criterion"],
      input_recipe: { expected: "fixture" }, response_kind: "boolean", allowed_values: null,
      missing_evidence_policy: "fail", abstain_semantics: "insufficient", unclear_semantics: "ambiguous",
      interpretation_caveats: "offline test", requires_repository_snapshot: false },
      evidence: { evidence_set_id: "offline-evidence", references: [], is_incomplete: false,
        incompleteness_reason: null },
      evaluator: { evaluator_definition_id: "offline-human", kind: "human", backend_kind: "local",
        provider: "offline-fixture", model: null, instruction_text: "fixture", prompt_digest: instructionDigest("fixture"), config_digest: "offline-config",
        runtime_revision: "1", cost_metadata: null, seed: null, attempt_controls: null } },
    details: { answer: { state: "answered", kind: "boolean", value: true }, reviewer_id: "offline-operator",
      collection_mode: "in_context", model_answers_visible: false, workflow_decisions_visible: false },
  }) });
  expect(grade.status).toBe(201);
  const history = await app.request(`/v1/items/${encodeURIComponent(criterion.occurrence_id)}/grades`,
    { headers: { authorization: "Bearer read-token" } });
  expect(history.status).toBe(200);
  expect((await history.json() as { total: number }).total).toBe(1);
  expect(app.routes.filter((route) => route.path.startsWith("/v1/langfuse/"))).toEqual([]);
  const absent = await app.request("/v1/langfuse/status", { headers: { Authorization: "Bearer read-token" } });
  expect(absent.status).toBe(404);
}));

test("partial configuration reports only field names, never supplied secret material", () => {
  const parsed = langfuseConfigFromEnv({ OBSERVATION_LANGFUSE_SECRET_KEY: "sensitive-value" });
  expect(parsed.ok).toBe(false);
  expect(JSON.stringify(parsed)).not.toContain("sensitive-value");
});


test("enabled configuration mounts all eight Langfuse routes", () => {
  const configuration = langfuseConfigFromEnv({ OBSERVATION_LANGFUSE_BASE_URL: "http://127.0.0.1:3000/",
    OBSERVATION_LANGFUSE_PROJECT_ID: "pilot", OBSERVATION_LANGFUSE_PUBLIC_KEY: "public",
    OBSERVATION_LANGFUSE_SECRET_KEY: "secret", OBSERVATION_LANGFUSE_PHASE_A_TRACE_ID: "a".repeat(32) });
  expect(configuration.ok).toBe(true);
  if (!configuration.ok) return;
  const app = createApp({ db: {} as Database, credentials, langfuse: configuration.value });
  expect(app.routes.filter((route) => route.path.startsWith("/v1/langfuse/"))
    .map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      "GET /v1/langfuse/label-series", "GET /v1/langfuse/status",
      "POST /v1/langfuse/annotation-queue/items", "POST /v1/langfuse/annotations/import",
      "POST /v1/langfuse/model-scores", "POST /v1/langfuse/projections",
      "POST /v1/langfuse/reconcile", "POST /v1/langfuse/score-configs",
    ]);
});


test("pilot runner uses authenticated HTTP instead of opening observation storage", async () => {
  const source = await Bun.file(new URL("../scripts/langfuse-pilot-run.ts", import.meta.url)).text();
  expect(source).not.toMatch(/openDatabase\s*\(|withTenant\s*\(|from ["']\.\.\/src\/storage\/database["']/);
});

test("pilot reads tenant-qualified source revisions with a read credential", async () => {
  const catalogue = LANGFUSE_PILOT_QUESTIONS["assessment.coverage"];
  const question = catalogue.definition;
  const evidence: EvidenceSet = { evidence_set_id: "pilot-evidence" as EvidenceSet["evidence_set_id"],
    references: [], is_incomplete: false, incompleteness_reason: null };
  const evaluator: EvaluatorDefinition = { evaluator_definition_id: "pilot-code", kind: "code",
    backend_kind: "local", provider: "pilot-test", model: null,
    prompt_digest: instructionDigest("pilot-test"), instruction_text: "pilot-test", config_digest: "pilot-config",
    runtime_revision: "1", cost_metadata: null, seed: null, attempt_controls: null };
  const occurrence_ids = Array.from({ length: 10 }, (_, index) => `occurrence-${index}` as ItemOccurrenceId);
  const strata = ["clearly_easy", "borderline", "known_failure"] as const;
  const plan: PilotRunPlan = { tenant, population: { manifest_id: "pilot-http", projection_version: "1",
    question_pins: [{ question_id: question.question_id, question_version: question.question_version }],
    selected: occurrence_ids.map((occurrence_id, index) => ({ occurrence_id,
      question_id: question.question_id, question_version: question.question_version,
      evidence, stratum: strata[index % strata.length]!, disposition: "included", reason: { kind: "operator", detail: "selected" } })) },
    attempts: occurrence_ids.map((occurrence_id) => ({ identity: { subject_occurrence_id: occurrence_id,
      evidence_set_id: evidence.evidence_set_id, question_id: question.question_id,
      question_version: question.question_version, evaluator_definition_id: evaluator.evaluator_definition_id,
      config_digest: evaluator.config_digest, attempt_label: "first" },
      context: { question, evidence, evaluator }, runner: "deterministic", split: "exploratory",
      question_text: catalogue.text, disagreement_cause: null })),
    human_grades: [], annotation_imports: [], examples: [] };
  const revision_reads: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    const token = request.headers.get("authorization");
    const expected = request.method === "GET" || path === "/v1/exports/assay"
      ? "Bearer read-token" : "Bearer grade-token";
    if (token !== expected) return Response.json({ error: "forbidden" }, { status: 403 });
    if (path === "/v1/evaluation-eligibility") return Response.json({ items: occurrence_ids.map((occurrence_id) => ({
      ...tenant, subject_occurrence_id: occurrence_id, question_id: question.question_id,
      question_version: question.question_version, tag: "eligible", payload: { evidence_set_id: evidence.evidence_set_id } })) });
    if (path.startsWith("/v1/items/") && path.endsWith("/grades"))
      return Response.json({ items: [], total: 0, limit: 200, offset: 0 });
    if (path.startsWith("/v1/items/")) return Response.json({ ...tenant, revision_id: "local-revision" });
    if (path.startsWith("/v1/source-revisions/")) {
      const identity = decodeURIComponent(path.slice("/v1/source-revisions/".length));
      if (identity !== `${tenant.producer}:${tenant.namespace}:local-revision`)
        return Response.json({ error: "not_found" }, { status: 404 });
      revision_reads.push(identity);
      return Response.json({ revision_id: "local-revision" });
    }
    if (path.startsWith("/v1/evaluations/by-digest/"))
      return Response.json({ error: "not_found" }, { status: 404 });
    if (path === "/v1/evaluations") return Response.json({ error: "not_graded" }, { status: 422 });
    if (path === "/v1/exports/assay") return Response.json({ error: "not_exported" }, { status: 409 });
    return Response.json({ error: "not_found" }, { status: 404 });
  } });
  try {
    const environment = { OBSERVATION_PILOT_BASE_URL: `http://127.0.0.1:${server.port}`,
      OBSERVATION_PILOT_GRADE_TOKEN: "grade-token", OBSERVATION_PILOT_READ_TOKEN: "read-token" };
    await expect(runPilot(plan, { ...environment, OBSERVATION_PILOT_READ_TOKEN: "wrong-token" }))
      .rejects.toThrow("eligibility read failed: 403");
    let did_freeze = false;
    const result = await runPilot(plan, environment, async () => { did_freeze = true; });
    expect(did_freeze).toBe(true);
    expect(revision_reads).toHaveLength(10);
    expect(result.measurements).toHaveLength(10);
  } finally { server.stop(); }
});

test("a network-runner pilot attempt goes through the durable queue, not the synchronous route", async () => {
  const catalogue = LANGFUSE_PILOT_QUESTIONS["assessment.coverage"];
  const question = catalogue.definition;
  const evidence: EvidenceSet = { evidence_set_id: "queued-evidence" as EvidenceSet["evidence_set_id"],
    references: [], is_incomplete: false, incompleteness_reason: null };
  const evaluator: EvaluatorDefinition = { evaluator_definition_id: "pilot-model", kind: "model",
    backend_kind: "local", provider: "typesafe", model: "jev-latest",
    prompt_digest: instructionDigest("pilot-test"), instruction_text: "pilot-test", config_digest: "pilot-config",
    runtime_revision: "1", cost_metadata: null, seed: null, attempt_controls: null };
  const occurrence_ids = Array.from({ length: 10 }, (_, index) => `queued-${index}` as ItemOccurrenceId);
  const strata = ["clearly_easy", "borderline", "known_failure"] as const;
  const plan: PilotRunPlan = { tenant, population: { manifest_id: "pilot-queued", projection_version: "1",
    question_pins: [{ question_id: question.question_id, question_version: question.question_version }],
    selected: occurrence_ids.map((occurrence_id, index) => ({ occurrence_id,
      question_id: question.question_id, question_version: question.question_version,
      evidence, stratum: strata[index % strata.length]!, disposition: "included", reason: { kind: "operator", detail: "selected" } })) },
    attempts: occurrence_ids.map((occurrence_id) => ({ identity: { subject_occurrence_id: occurrence_id,
      evidence_set_id: evidence.evidence_set_id, question_id: question.question_id,
      question_version: question.question_version, evaluator_definition_id: evaluator.evaluator_definition_id,
      config_digest: evaluator.config_digest, attempt_label: "first" },
      context: { question, evidence, evaluator }, runner: "jev_direct", split: "exploratory",
      question_text: catalogue.text, disagreement_cause: null, estimated_cost: 0.01 })),
    human_grades: [], annotation_imports: [], examples: [] };

  const synchronous_calls: string[] = [];
  const enqueued: { readonly estimated_cost: unknown; readonly runner: unknown }[] = [];
  const projected: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/v1/evaluation-eligibility") return Response.json({ items: occurrence_ids.map((occurrence_id) => ({
      ...tenant, subject_occurrence_id: occurrence_id, question_id: question.question_id,
      question_version: question.question_version, tag: "eligible", payload: { evidence_set_id: evidence.evidence_set_id } })) });
    if (path.startsWith("/v1/items/") && path.endsWith("/grades"))
      return Response.json({ items: [], total: 0, limit: 200, offset: 0 });
    if (path.startsWith("/v1/items/")) return Response.json({ ...tenant, revision_id: "local-revision" });
    if (path.startsWith("/v1/source-revisions/")) return Response.json({ revision_id: "local-revision" });
    if (path === "/v1/evaluation-jobs") {
      const body = await request.json() as { estimated_cost: unknown; runner: unknown };
      enqueued.push({ estimated_cost: body.estimated_cost, runner: body.runner });
      // Already settled, so the pilot resolves the execution without polling.
      return Response.json({ job_id: `job-${enqueued.length}`, state: "terminal",
        idempotency_digest: `digest-${enqueued.length}` }, { status: 201 });
    }
    if (path.startsWith("/v1/evaluations/by-digest/"))
      return Response.json({ execution: { execution_id: `execution-${path.split("-").at(-1)}` } });
    if (path === "/v1/evaluations") { synchronous_calls.push(path);
      return Response.json({ error: { code: "queued_evaluation_required" } }, { status: 422 }); }
    if (path === "/v1/langfuse/projections") { projected.push(path); return Response.json({ recorded: true }); }
    if (path === "/v1/exports/assay") return Response.json({ error: "not_exported" }, { status: 409 });
    return Response.json({ error: "not_found" }, { status: 404 });
  } });
  try {
    const result = await runPilot(plan, { OBSERVATION_PILOT_BASE_URL: `http://127.0.0.1:${server.port}`,
      OBSERVATION_PILOT_GRADE_TOKEN: "grade-token", OBSERVATION_PILOT_READ_TOKEN: "read-token" });
    // The synchronous route refuses network runners, so the pilot must never reach for it.
    expect(synchronous_calls).toEqual([]);
    expect(enqueued).toHaveLength(10);
    expect(enqueued.every((job) => job.runner === "jev_direct" && job.estimated_cost === 0.01)).toBe(true);
    expect(projected).toHaveLength(10);
    expect(result.operations.filter((entry) => entry.operation === "enqueue"
      && entry.status === 201)).toHaveLength(10);
  } finally { server.stop(); }
});

test("only the three provider runners are routed through the queue", () => {
  const network: readonly PilotRunner[] = ["jev_direct", "fastino_glide", "llm_judge"];
  const local: readonly PilotRunner[] = ["deterministic", "coverage"];
  expect(network.every(isNetworkRunner)).toBe(true);
  expect(local.some(isNetworkRunner)).toBe(false);
});
