import { instructionDigest } from "../src/grading/evaluator";
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { canonicalDigest } from "../src/canonical/canonical-json";
import type { JsonValue } from "../src/domain/primitives";
import { createApp } from "../src/http/app";
import { langfuseConfigFromEnv } from "../src/langfuse/config";
import { LANGFUSE_PILOT_QUESTIONS } from "../src/grading/catalogue/langfuse-pilot";
import type { EvaluatorDefinition } from "../src/grading/evaluator";
import type { ItemOccurrenceId } from "../src/domain/identity";
import { openDatabase, type Database } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { isNetworkRunner, runPilot, type PilotRunner, type PilotRunPlan } from "../scripts/langfuse-pilot-run";
import { dropScratchDatabase } from "./database-fixture";
import { deriveSubjectGradeability } from "../src/producers/oakridge/gradeability";
import { createJevDirectRunner } from "../src/runners/jev-direct";
import { workOneJob } from "../src/grading/jobs/worker";
import { gradingLimits } from "../src/grading/jobs/budget";

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

integration("pilot measures captured revisions through the real app and reports a refused attempt", async () => scratch(async (db) => {
  const app = createApp({ db, credentials });
  const body = await Bun.file(new URL("../fixtures/oakridge/run-slice/plan-revision.json", import.meta.url)).json() as {
    cohorts: { acceptance_criteria: { id: string; text: string; task_ids: string[]; decision_ids: string[] }[] }[] };
  body.cohorts[0]!.acceptance_criteria = Array.from({ length: 10 }, (_, index) => ({
    id: `criterion-${index}`, text: `Criterion ${index}`, task_ids: [], decision_ids: ["decision-capture"] }));
  const digest = canonicalDigest(body);
  if (!digest.ok) throw new Error(digest.error.detail);
  const delivered = await app.request("/v1/sources/oakridge/sync", { method: "POST", headers: {
    authorization: "Bearer ingest-token", "idempotency-key": "pilot-plan", "content-type": "application/json" },
    body: JSON.stringify({ format: "observation.artifact-revision/v1", source: { ...tenant,
      revision_id: `${tenant.producer}:${tenant.namespace}:pilot-plan`, run_id: "pilot-run", unit_id: "planning/slice", collection_key: "slice",
      artifact_kind: "plan", artifact_schema_version: "development-v1",
      definition_bundle: { id: "development", digest: "fixture-bundle" } },
      recorded_at: "2026-10-28T10:00:00.000Z", body, body_digest: digest.value }) });
  expect(delivered.status).toBe(201);
  const catalogue = LANGFUSE_PILOT_QUESTIONS["plan.criterion_traceability"];
  const question = catalogue.definition;
  const eligibility = await app.request(`/v1/evaluation-eligibility?question_id=${question.question_id}&question_version=${question.question_version}&run_id=pilot-run`,
    { headers: { authorization: "Bearer read-token" } });
  expect(eligibility.status).toBe(200);
  const rows = (await eligibility.json() as { items: { subject_occurrence_id: ItemOccurrenceId; tag: string;
    payload: { evidence_set_id: string } }[] }).items.filter((row) => row.tag === "eligible");
  expect(rows).toHaveLength(10);
  const model: EvaluatorDefinition = { evaluator_definition_id: "pilot-model", kind: "model",
    backend_kind: "local", provider: "typesafe", model: "jev-1.14.0",
    prompt_digest: instructionDigest(JSON.stringify({ system_one: { type: "choice", instructions: "Judge traceability",
      criteria: Object.fromEntries(question.allowed_values!.map((value) => [value, String(value)])) } })),
    instruction_text: JSON.stringify({ system_one: { type: "choice", instructions: "Judge traceability",
      criteria: Object.fromEntries(question.allowed_values!.map((value) => [value, String(value)])) } }),
    config_digest: "pilot-config", runtime_revision: "1", cost_metadata: null, seed: null, attempt_controls: null };
  const selected = [] as PilotRunPlan["population"]["selected"][number][];
  const attempts = [] as PilotRunPlan["attempts"][number][];
  for (const [index, row] of rows.entries()) {
    const derived = await deriveSubjectGradeability(db, tenant, row.subject_occurrence_id,
      question.question_id, question.question_version);
    if (!derived.ok || !derived.value.evidence) throw new Error("captured evidence missing");
    const evidence = derived.value.evidence;
    const identity = { subject_occurrence_id: row.subject_occurrence_id, evidence_set_id: evidence.evidence_set_id,
      question_id: question.question_id, question_version: question.question_version,
      evaluator_definition_id: model.evaluator_definition_id, config_digest: index === 9 ? "refused-config" : model.config_digest,
      attempt_label: "pilot" };
    const context = { question, evidence, evaluator: model };
    selected.push({ occurrence_id: row.subject_occurrence_id, question_id: question.question_id,
      question_version: question.question_version, evidence,
      stratum: (["clearly_easy", "borderline", "known_failure"] as const)[index % 3]!,
      disposition: "included", reason: { kind: "operator", detail: "selected" } });
    attempts.push({ identity, context, runner: "jev_direct", split: "exploratory", question_text: catalogue.text,
      disagreement_cause: null, estimated_cost: 0.01 });
  }
  const runner = createJevDirectRunner({ api_key: "controlled", base_url: "https://provider.test/v1",
    transport: async () => Response.json({ model: "jev-1.14.0", answers: { [question.question_id]: {
      type: "choice", choice: "traceable", confidence: 0.8,
      probabilities: Object.fromEntries(question.allowed_values!.map((value) => [value, value === "traceable" ? 0.7 : 0.1])) } },
      usage: { input_tokens: 10, output_tokens: 2 }, cost: 0.01, id: "controlled" }) });
  for (const attempt of attempts.slice(0, 9)) {
    const response = await app.request("/v1/evaluation-jobs", { method: "POST",
      headers: { authorization: "Bearer grade-token", "content-type": "application/json" },
      body: JSON.stringify({ identity: attempt.identity, context: attempt.context, runner: "jev_direct", estimated_cost: 0.01 }) });
    expect(response.status).toBe(201);
    await workOneJob(db, tenant, { ...gradingLimits(), run_spend: 10, stage_spend: 10 }, "pilot-worker", runner);
  }
  const server = Bun.serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  try {
    const plan: PilotRunPlan = { tenant, population: { manifest_id: "pilot-real", projection_version: "1",
      question_pins: [{ question_id: question.question_id, question_version: question.question_version }], selected },
      attempts, human_grades: [], annotation_imports: [], examples: [] };
    const environment = { OBSERVATION_PILOT_BASE_URL: `http://127.0.0.1:${server.port}`,
      OBSERVATION_PILOT_GRADE_TOKEN: "grade-token", OBSERVATION_PILOT_READ_TOKEN: "read-token" };
    await expect(runPilot(plan, { ...environment, OBSERVATION_PILOT_READ_TOKEN: "wrong-token" }))
      .rejects.toThrow("eligibility read failed: 403");
    const result = await runPilot(plan, environment);
    expect(result.population.membership.filter((member) => member.disposition === "included")).toHaveLength(10);
    expect(result.measurements).toHaveLength(9);
    expect(result.operations.some((entry) => entry.operation === "enqueue" && entry.status >= 300)).toBe(true);
    expect(result.operations.some((entry) => entry.operation === "measurement"
      && entry.status === 409 && entry.detail.includes("no execution"))).toBe(true);
  } finally { server.stop(); }
}));

test("only the three provider runners are routed through the queue", () => {
  const network: readonly PilotRunner[] = ["jev_direct", "fastino_glide", "llm_judge"];
  const local: readonly PilotRunner[] = ["deterministic", "coverage"];
  expect(network.every(isNetworkRunner)).toBe(true);
  expect(local.some(isNetworkRunner)).toBe(false);
});
