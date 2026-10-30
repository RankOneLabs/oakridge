import { instructionDigest } from "../src/grading/evaluator";
import { randomBytes } from "node:crypto";
import { expect, test } from "bun:test";
import { Client } from "pg";
import { canonicalDigest } from "../src/canonical/canonical-json";
import type { JsonValue } from "../src/domain/primitives";
import { createApp } from "../src/http/app";
import { openDatabase, withTenant, type Database } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { listRunItems, readLineage } from "../src/storage/projection-store";
import { dropScratchDatabase } from "./database-fixture";

const serverUrl = process.env.OAKRIDGE_TEST_DATABASE_URL;
const integration = serverUrl ? test : test.skip;
test("failure cases require OAKRIDGE_TEST_DATABASE_URL", () => {
  expect(serverUrl).toBeTruthy();
});
const tenant = { producer: "oakridge", namespace: "failure-cases" };
const run_id = "run-failure-fixtures";
const credentials = { ingest: [{ ...tenant, token: "ingest-fixture" }], read: [{ ...tenant, token: "read-fixture" }],
  grade: [{ ...tenant, token: "grade-fixture", reviewer_id: "operator" }] };
const fixture = async (name: string): Promise<JsonValue> => Bun.file(new URL(`../fixtures/oakridge/run-slice/${name}-revision.json`, import.meta.url)).json() as Promise<JsonValue>;
interface PlanCriterion { id: string; text: string; task_ids: string[]; decision_ids: string[] }
interface PlanBody { summary: string; cohorts: { acceptance_criteria: PlanCriterion[] }[] }
interface FailureCases {
  readonly duplicate_item: { readonly id: string; readonly text: string };
  readonly reordered_criterion_ids: readonly string[];
  readonly revision_update: { readonly id: string; readonly text: string };
  readonly missing_source_ref: string;
  readonly conflicting_duplicate: { readonly revision_id: string; readonly summary: string };
  readonly incomplete_evidence: { readonly reason: string };
  readonly repeated_delivery: { readonly event_id: string };
  readonly grader_failure: { readonly question_id: string };
  readonly human_correction: { readonly first: boolean; readonly corrected: boolean };
}
const failureCases = async (): Promise<FailureCases> => (await Bun.file(new URL(
  "../fixtures/oakridge/run-slice/events.json", import.meta.url)).json() as { failure_cases: FailureCases }).failure_cases;
const digest = (body: JsonValue) => {
  const result = canonicalDigest(body);
  if (!result.ok) throw new Error(result.error.detail);
  return result.value;
};
async function scratch(work: (db: Database) => Promise<void>): Promise<void> {
  if (!serverUrl) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required");
  const name = `observation_failures_${randomBytes(6).toString("hex")}`;
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
type App = ReturnType<typeof createApp>;
async function ingest(app: App, kind: string, revision: string, body: JsonValue, at: number,
  predecessor: string | null = null, key = revision): Promise<Response> {
  return app.request("/v1/sources/oakridge/sync", { method: "POST", headers: {
    authorization: "Bearer ingest-fixture", "idempotency-key": key, "content-type": "application/json" },
  body: JSON.stringify({ format: "observation.artifact-revision/v1", source: { ...tenant,
    revision_id: `${tenant.producer}:${tenant.namespace}:${revision}`, run_id,
    unit_id: kind === "plan" ? `${run_id}/planning` : kind === "brief" ? `${run_id}/briefs/slice` : `${run_id}/implementation/slice`,
    artifact_kind: kind, artifact_schema_version: "development-v1",
    definition_bundle: { id: "development", digest: "fixture-bundle" },
    predecessor_id: predecessor ? `${tenant.producer}:${tenant.namespace}:${predecessor}` : null, subject_id: null },
    recorded_at: `2026-10-28T00:00:${String(at).padStart(2, "0")}.000Z`, body, body_digest: digest(body) }) });
}

integration("duplicate ids, reorder, revision update, missing source and conflicting duplicate retain explicit outcomes", async () => scratch(async (db) => {
  const app = createApp({ db, credentials });
  const cases = await failureCases();
  const plan = await fixture("plan") as unknown as PlanBody;
  const firstDelivery = await ingest(app, "plan", "plan-1", plan as unknown as JsonValue, 1,
    null, cases.repeated_delivery.event_id);
  expect(firstDelivery.status).toBe(201);
  const firstAck = await firstDelivery.json();
  const original = (await listRunItems(db, tenant, run_id, { limit: 100, offset: 0 })).items
    .filter((item) => item.revision_id === "plan-1" && item.item_kind === "criterion");
  expect(original).toHaveLength(2);

  // Two criteria with one producer ID collide inside a single revision; the first remains visible.
  const duplicate = structuredClone(plan);
  duplicate.cohorts[0]!.acceptance_criteria.push({ ...duplicate.cohorts[0]!.acceptance_criteria[0]!,
    ...cases.duplicate_item });
  expect((await ingest(app, "plan", "plan-duplicate", duplicate as unknown as JsonValue, 2)).status).toBe(201);
  const duplicatePage = await listRunItems(db, tenant, run_id, { limit: 100, offset: 0 });
  expect(duplicatePage.issues.some((issue) => issue.revision_id === "plan-duplicate" && issue.kind === "identity_collision")).toBe(true);
  expect(duplicatePage.items.filter((item) => item.revision_id === "plan-duplicate" && item.item_kind === "criterion")).toHaveLength(2);

  // Reordering a successor changes JSON paths, while identified logical items keep their identity.
  const reordered = structuredClone(plan);
  reordered.cohorts[0]!.acceptance_criteria.sort((a, b) => cases.reordered_criterion_ids.indexOf(a.id)
    - cases.reordered_criterion_ids.indexOf(b.id));
  expect(reordered.cohorts[0]!.acceptance_criteria.map((criterion) => criterion.id)).toEqual([...cases.reordered_criterion_ids]);
  expect((await ingest(app, "plan", "plan-2", reordered as unknown as JsonValue, 3, "plan-1")).status).toBe(201);
  const reorderedItems = (await listRunItems(db, tenant, run_id, { limit: 100, offset: 0 })).items
    .filter((item) => item.revision_id === "plan-2" && item.item_kind === "criterion");
  expect(reorderedItems.map((item) => item.json_pointer).sort()).toEqual(original.map((item) => item.json_pointer).sort());
  expect(reorderedItems.every((item) => original.some((old) => old.logical_item_id === item.logical_item_id
    && old.occurrence_id !== item.occurrence_id))).toBe(true);
  expect(reorderedItems.every((item) => original.some((old) => old.logical_item_id === item.logical_item_id
    && old.json_pointer !== item.json_pointer))).toBe(true);

  // An edit creates a new immutable revision, and lineage identifies it as a change.
  const edited = structuredClone(reordered);
  edited.cohorts[0]!.acceptance_criteria.find((criterion) => criterion.id === cases.revision_update.id)!.text
    = cases.revision_update.text;
  expect((await ingest(app, "plan", "plan-3", edited as unknown as JsonValue, 4, "plan-2")).status).toBe(201);
  const editedItem = (await listRunItems(db, tenant, run_id, { limit: 100, offset: 0 })).items
    .find((item) => item.revision_id === "plan-3" && item.item_kind === "criterion")!;
  expect((await readLineage(db, tenant, editedItem.occurrence_id, { limit: 100, offset: 0 }))?.republication)
    .toEqual({ predecessor_revision_id: `${tenant.producer}:${tenant.namespace}:plan-2`, is_republication: false });
  const oldRevision = await app.request(`/v1/source-revisions/${tenant.producer}:${tenant.namespace}:plan-1`,
    { headers: { authorization: "Bearer read-fixture" } });
  expect((await oldRevision.json()).body).toEqual(plan);

  // The missing assessment target is retained as an unresolved producer reference.
  expect((await ingest(app, "brief", "brief-1", await fixture("brief"), 5)).status).toBe(201);
  expect((await ingest(app, "assessment", "assessment-1", await fixture("assessment"), 6)).status).toBe(201);
  const missing = (await listRunItems(db, tenant, run_id, { limit: 100, offset: 0 })).items
    .find((item) => item.revision_id === "assessment-1" && item.item_id_or_path === "/findings/1")!;
  const lineage = await readLineage(db, tenant, missing.occurrence_id, { limit: 100, offset: 0 });
  expect(lineage?.unresolved.some((edge) => edge.unresolved_target_ref?.includes(cases.missing_source_ref))).toBe(true);
  expect(lineage?.edges.some((edge) => edge.type === "assesses" && edge.target_occurrence_id !== null)).toBe(false);

  // A repeated delivery reuses one revision. A different body under that identity is refused.
  const repeated = await ingest(app, "plan", "plan-1", plan as unknown as JsonValue, 1,
    null, cases.repeated_delivery.event_id);
  expect(repeated.status).toBe(201);
  expect(await repeated.json()).toEqual(firstAck);
  const conflictingBody = { ...plan, summary: cases.conflicting_duplicate.summary };
  const conflict = await ingest(app, "plan", cases.conflicting_duplicate.revision_id,
    conflictingBody as unknown as JsonValue, 1, null, "conflicting-delivery");
  expect(conflict.status).toBe(409);
  expect((await conflict.json()).error.code).toBe("revision_identity_conflict");
  const revisionCount = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.source_revision")
    .select("revision_id").where("revision_id", "=", "plan-1").execute());
  expect(revisionCount).toHaveLength(1);
  const preserved = await app.request(`/v1/source-revisions/${tenant.producer}:${tenant.namespace}:plan-1`,
    { headers: { authorization: "Bearer read-fixture" } });
  expect((await preserved.json()).body).toEqual(plan);
}));

integration("incomplete evidence, runner failure and human correction preserve grade history", async () => scratch(async (db) => {
  const app = createApp({ db, credentials });
  const cases = await failureCases();
  expect((await ingest(app, "brief", "brief-1", await fixture("brief"), 1)).status).toBe(201);
  const subject = (await listRunItems(db, tenant, run_id, { limit: 100, offset: 0 })).items
    .find((item) => item.item_kind === "criterion")!;
  const headers = { authorization: "Bearer grade-fixture", "content-type": "application/json" };
  const question = (id: string, expected: string | undefined, requires_repository_snapshot = false) => ({
    question_id: id, question_version: "1", target_item_kinds: ["criterion"],
    input_recipe: expected === undefined ? {} : { expected }, response_kind: "boolean", allowed_values: null,
    missing_evidence_policy: "fail", abstain_semantics: "insufficient", unclear_semantics: "ambiguous",
    interpretation_caveats: "fixture", requires_repository_snapshot });
  const evidence = (id: string, incomplete: boolean) => ({ evidence_set_id: id,
    references: [{ ref: "fixture", kind: "public", content: "matching", digest: null }],
    is_incomplete: incomplete, incompleteness_reason: incomplete ? cases.incomplete_evidence.reason : null });
  const evaluator = (kind: "code" | "human") => ({ evaluator_definition_id: `${kind}-failure`, kind,
    backend_kind: "local", provider: "fixture", model: null, instruction_text: "prompt", prompt_digest: instructionDigest("prompt"),
    config_digest: "config", runtime_revision: "1", cost_metadata: null, seed: null, attempt_controls: null });
  const identity = (question_id: string, evidence_set_id: string, kind: "code" | "human", attempt_label = "first") => ({
    subject_occurrence_id: subject.occurrence_id, evidence_set_id, question_id, question_version: "1",
    evaluator_definition_id: `${kind}-failure`, config_digest: "config", attempt_label });

  const incomplete = await app.request("/v1/evaluations", { method: "POST", headers,
    body: JSON.stringify({ identity: identity("needs-snapshot", "incomplete", "code"),
      context: { question: question("needs-snapshot", "matching", true), evidence: evidence("incomplete", true),
        evaluator: evaluator("code") }, runner: "deterministic" }) });
  expect(incomplete.status).toBe(201);
  expect(await incomplete.json()).toMatchObject({ execution: { status: "failed",
    error: cases.incomplete_evidence.reason }, observation: null });

  const failed = await app.request("/v1/evaluations", { method: "POST", headers,
    body: JSON.stringify({ identity: identity(cases.grader_failure.question_id, "complete", "code"),
      context: { question: question(cases.grader_failure.question_id, undefined), evidence: evidence("complete", false),
        evaluator: evaluator("code") }, runner: "deterministic" }) });
  expect(failed.status).toBe(201);
  expect(await failed.json()).toMatchObject({ execution: { status: "failed" }, observation: null });

  const base = { identity: identity("human-correction", "complete", "human"),
    context: { question: question("human-correction", "matching"), evidence: evidence("complete", false),
      evaluator: evaluator("human") },
    details: { answer: { state: "answered", kind: "boolean", value: cases.human_correction.first }, reviewer_id: "operator",
      collection_mode: "in_context", model_answers_visible: false, workflow_decisions_visible: true } };
  const first = await app.request("/v1/grades", { method: "POST", headers, body: JSON.stringify(base) });
  expect(first.status).toBe(201);
  const initial = await first.json() as { observation: { observation_id: string } };
  const correction = await app.request("/v1/grades", { method: "POST", headers,
    body: JSON.stringify({ ...base, identity: { ...base.identity, attempt_label: "correction" },
      context: undefined, details: { answer: { state: "answered", kind: "boolean", value: cases.human_correction.corrected },
        reviewer_id: "operator", supersedes_observation_id: initial.observation.observation_id,
        collection_mode: "in_context", model_answers_visible: false, workflow_decisions_visible: true } }) });
  expect(correction.status).toBe(201);
  const corrected = await correction.json() as { observation: { observation_id: string; supersedes_observation_id: string } };
  expect(corrected.observation.supersedes_observation_id).toBe(initial.observation.observation_id);
  expect(corrected.observation.observation_id).not.toBe(initial.observation.observation_id);
  const history = await app.request(`/v1/items/${encodeURIComponent(subject.occurrence_id)}/grades`,
    { headers: { authorization: "Bearer read-fixture" } });
  const gradePage = await history.json() as { total: number; items: { observation: { observation_id: string } }[] };
  expect(gradePage.total).toBe(2);
  expect(gradePage.items.map((item) => item.observation.observation_id).sort()).toEqual([
    initial.observation.observation_id, corrected.observation.observation_id].sort());
}));
