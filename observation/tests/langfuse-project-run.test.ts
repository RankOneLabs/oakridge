import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { canonicalDigest } from "../src/canonical/canonical-json";
import type { ItemOccurrenceId } from "../src/domain/identity";
import type { JsonValue } from "../src/domain/primitives";
import { LANGFUSE_PILOT_QUESTIONS } from "../src/grading/catalogue/langfuse-pilot";
import { LangfuseBackend } from "../src/langfuse/backend";
import type { LangfuseConfig } from "../src/langfuse/config";
import { createLangfuseHttpClient } from "../src/langfuse/http-client";
import { nativeIdentity, nativeJevEvaluator } from "../src/langfuse/native-evaluator";
import { RESTRICTED_POLICY } from "../src/langfuse/projection";
import { latestRevisions, runPackages, type CapturedRevision } from "../src/langfuse/run-packages";
import { oakridgeDevelopmentCatalogue } from "../src/projection/catalogue/oakridge-development";
import { selectRevision } from "../src/projection/extractor";
import { openDatabase, withTenant, type Database } from "../src/storage/database";
import { registerGradingContext, startDelegatedExecution } from "../src/storage/grading-store";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { projectRevision } from "../src/storage/projection-store";
import { loadProjectionInput } from "../src/storage/projection-input";
import { loadRunCapture } from "../src/storage/run-capture-store";
import { dropScratchDatabase } from "./database-fixture";

type Criterion = { task_ids: string[]; decision_ids: string[] };
const tasksBody: JsonValue = { tasks: [{ id: "task-1", description: "Build A", requirement_ids: [] }] };
const planBody = (criterion: Criterion): JsonValue => ({ cohorts: [{ id: "alpha",
  decisions: [{ id: "decision-a", text: "Choose A" }],
  acceptance_criteria: [{ id: "crit-a", text: "A works", ...criterion }] }] });
const briefBody = (criterion_id: string): JsonValue => ({ cohort_id: "alpha", decisions_made: [], approaches_rejected: [],
  acceptance_criteria: [{ id: criterion_id, text: "A works reliably", task_ids: [], decision_ids: [] }] });

function revision(revision_id: string, artifact_kind: string, body: JsonValue, at: number, unit_id = "run-1/plan"): CapturedRevision {
  const items = selectRevision(body, revision_id, oakridgeDevelopmentCatalogue(artifact_kind, "development-v1"))
    .items.map(({ item }) => ({ ...item, occurrence_id: `${revision_id}:${item.item_id_or_path}` as ItemOccurrenceId }));
  return { revision_id, unit_id, artifact_kind, recorded_at: new Date(at), items };
}
function packaged(revisions: readonly CapturedRevision[]) {
  const result = runPackages(revisions);
  if (!result.ok) throw new Error(result.error.detail);
  return result.value;
}

test("a plan criterion is packaged with its cited task and decision under role-prefixed refs", () => {
  const result = packaged([revision("tasks-1", "tasks", tasksBody, 1),
    revision("plan-1", "plan", planBody({ task_ids: ["task-1"], decision_ids: ["decision-a"] }), 2)]);
  expect(result.packages.map((pilot) => [pilot.question_id, pilot.evidence.references.map((ref) => ref.ref)]))
    .toEqual([["plan.criterion_traceability", ["plan_criterion:crit-a", "plan_task:task-1", "plan_decision:decision-a"]]]);
  expect(result.packages[0]?.evidence.references.every((ref) => ref.kind === "public" && ref.content !== null)).toBe(true);
});

test("an uncited plan criterion is excluded, not packaged", () => {
  const result = packaged([revision("plan-1", "plan", planBody({ task_ids: [], decision_ids: [] }), 1)]);
  expect(result.packages).toEqual([]);
  expect(result.exclusions.map((exclusion) => exclusion.reason)).toEqual([{ kind: "uncited" }]);
});

test("cited tasks with no captured tasks revision make the evidence incomplete", () => {
  const result = packaged([revision("plan-1", "plan", planBody({ task_ids: ["task-1"], decision_ids: [] }), 1)]);
  expect(result.packages[0]?.evidence).toMatchObject({ is_incomplete: true,
    incompleteness_reason: "the run's tasks revision was not captured" });
});

test("only the latest revision of each artifact in a unit is packaged", () => {
  const older = revision("plan-1", "plan", planBody({ task_ids: [], decision_ids: ["decision-a"] }), 1);
  const newer = revision("plan-2", "plan", planBody({ task_ids: [], decision_ids: ["decision-a"] }), 2);
  expect(latestRevisions([newer, older]).map((entry) => entry.revision_id)).toEqual(["plan-2"]);
  expect(packaged([older, newer]).packages.map((pilot) => pilot.revision_id)).toEqual(["plan-2"]);
});

test("a brief criterion is paired with the plan criterion of the same id; one without a source is excluded", () => {
  const plan = revision("plan-1", "plan", planBody({ task_ids: [], decision_ids: ["decision-a"] }), 1);
  const result = packaged([plan, revision("brief-1", "brief", briefBody("crit-a"), 2, "run-1/alpha"),
    revision("brief-2", "brief", briefBody("crit-gone"), 3, "run-1/beta")]);
  const brief = result.packages.filter((pilot) => pilot.question_id === "brief.source_fidelity");
  expect(brief.map((pilot) => pilot.evidence.references.map((ref) => ref.ref)))
    .toEqual([["plan_criterion:crit-a", "brief_criterion:crit-a"]]);
  expect(result.exclusions.filter((exclusion) => exclusion.question_id === "brief.source_fidelity")
    .map((exclusion) => exclusion.reason.kind)).toEqual(["dangling_citation"]);
});

const serverUrl = process.env.OAKRIDGE_TEST_DATABASE_URL;
const integration = serverUrl || process.env.CI === "true" ? test : test.skip;
const tenant = { producer: "oakridge", namespace: "project-run-test" };
const config: LangfuseConfig = { base_url: "https://example.langfuse.test", project_id: "project-1",
  credential: { public_key: "public", secret_key: "private" }, annotation_queue_id: null,
  decision_evaluator_id: "evaluator-1", decision_model: "jev-latest", phase_a_trace_id: "a".repeat(32),
  retry: { max_attempts: 1, backoff_ms: 0 } };

async function scratch(work: (db: Database) => Promise<void>): Promise<void> {
  if (!serverUrl) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required");
  const name = `observation_project_run_${randomBytes(6).toString("hex")}`;
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
async function capture(db: Database, revision_id: string, artifact_kind: string, body: JsonValue, at: number, unit_id: string) {
  const digest = canonicalDigest(body);
  if (!digest.ok) throw new Error(digest.error.detail);
  await withTenant(db, tenant, (trx) => trx.insertInto("observation.source_revision").values({ ...tenant,
    revision_id, run_id: "run-1", unit_id, artifact_kind, artifact_schema_version: "development-v1",
    definition_bundle_id: "development", definition_bundle_digest: "bundle-sha256:test", body,
    body_digest: digest.value, predecessor_id: null, subject_id: null, recorded_at: new Date(at) }).execute());
  await projectRevision(db, tenant, revision_id);
}

integration("a captured run's plan criterion reaches Langfuse as one span carrying its evidence text", async () => scratch(async (db) => {
  await capture(db, "tasks-1", "tasks", tasksBody, 1_000, "run-1/plan");
  await capture(db, "plan-1", "plan", planBody({ task_ids: ["task-1"], decision_ids: ["decision-a"] }), 2_000, "run-1/plan");
  const loaded = await loadRunCapture(db, tenant, "run-1");
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const [pilot] = packaged(loaded.value).packages;
  if (!pilot) throw new Error("no package");
  const entry = LANGFUSE_PILOT_QUESTIONS[pilot.question_id];
  const evaluator = nativeJevEvaluator(pilot.question_id, "v1", entry.text, "jev-latest");
  if (!evaluator.ok) throw new Error(evaluator.error.detail);
  expect((await registerGradingContext(db, tenant, { question: entry.definition, evidence: pilot.evidence,
    evaluator: evaluator.value })).ok).toBe(true);
  const identity = nativeIdentity(pilot, evaluator.value, "v1");
  const execution = await startDelegatedExecution(db, tenant, identity);
  const replay = await startDelegatedExecution(db, tenant, identity);
  if (!execution.ok || !replay.ok) throw new Error("delegated execution was not recorded");
  expect([execution.value.status, execution.value.ended_at, replay.value.execution_id])
    .toEqual(["running", null, execution.value.execution_id]);
  const input = await loadProjectionInput(db, tenant, { execution_id: execution.value.execution_id,
    question_text: entry.text, projection_version: "v1", policy: RESTRICTED_POLICY });
  if (!input) throw new Error("projection input was not loaded");
  const posts: string[] = [];
  const transport = async (url: string, init: RequestInit) => {
    if (init?.method === "POST") { posts.push(String(init.body)); return Response.json({}); }
    if (url.endsWith("/api/openapi.yaml")) return new Response("info:\n  version: 4.36.0\npaths:\n  /api/public/v2/evaluators:\n  /api/public/annotation-queues:\n  /api/public/v3/scores:\n  /api/public/v2/evaluation-rules:\n");
    if (url.includes("/v2/evaluation-rules?")) return Response.json({ data: [{ enabled: true,
      evaluatorAssignments: [{ evaluatorId: "evaluator-1", variableMapping: null }] }], meta: {} });
    return Response.json({ data: [] });
  };
  const projected = await new LangfuseBackend(db, tenant, config, createLangfuseHttpClient(config, transport)).project(input);
  expect(projected.ok && projected.value.status).toBe("written");
  const span = JSON.parse(posts[0]!).resourceSpans[0].scopeSpans[0].spans[0] as
    { name: string; attributes: { key: string; value: { stringValue: string } }[] };
  const observationInput = JSON.parse(span.attributes.find((item) => item.key === "langfuse.observation.input")!.value.stringValue);
  expect(span.name).toBe("plan.criterion_traceability@v1");
  expect(observationInput.evidence_set.evidence_refs.map((ref: { ref: string; content: unknown }) => [ref.ref, ref.content !== null]))
    .toEqual([["plan_criterion:crit-a", true], ["plan_task:task-1", true], ["plan_decision:decision-a", true]]);
}));
