import { targetOf } from "./grading-fixture";
import { expect } from "bun:test";
import type { ArtifactRevisionId, EvaluatorDefinitionId, ItemOccurrenceId } from "../src/domain/identity";
import type { JsonValue } from "../src/domain/primitives";
import { humanEvaluator } from "../src/grading/configuration";
import type { CaptureConfiguration } from "../src/grading/evidence";
import { createApp } from "../src/http/app";
import type { Credentials } from "../src/http/ingest-auth";
import { CORRECTNESS_ID, EVIDENCE_SUPPORT_ID } from "./grading-fixture";
import { OAKRIDGE_QUESTIONS, questionVersion, oakridgeProfile, createFeed, evaluator, evaluatorId, integration, runConfig, scratchDatabase, tenant, type Feed } from "./grading-fixture";
import { readOccurrenceEvidence, recordCollection } from "../src/storage/captured-evidence-store";
import type { Database, TenantScope } from "../src/storage/database";
import { registerEvaluator, registerQuestion } from "../src/storage/grading-store";
import { admitRun, claimNext, completeExecution, failExecution } from "../src/storage/execution-store";

const other: TenantScope = { producer: "oakridge", namespace: "other-tenant" };
const credentials: Credentials = { ingest: [{ ...tenant, token: "ingest" }], read: [{ ...tenant, token: "read" }, { ...other, token: "other-read" }],
  grade: [{ ...tenant, token: "grade", reviewer_id: "operator" }] };
const MACHINE = "machine";
const human = (() => { const definition = humanEvaluator(); if (!definition.ok) throw new Error(definition.error.detail); return definition.value; })();
const pins: CaptureConfiguration = { pins: OAKRIDGE_QUESTIONS.map((question) => ({ scope: "per_item" as const, ...question, ...targetOf(question.question_id),
  evaluator_definition_ids: [evaluatorId(MACHINE), human.evaluator_definition_id as EvaluatorDefinitionId] })) };
const analysis = (findings: readonly JsonValue[]): JsonValue => ({ summary: "s", source_spec_refs: [], findings, requirements: [], risks: [], proposed_spec_updates: [] });
const assessment = (findings: readonly JsonValue[]): JsonValue => ({ head_sha: "abc", verdict: "pass", findings, recommended_next_actions: [] });
const finding = (task_ids: readonly string[], description: string): JsonValue => ({ task_ids, status: "met", evidence: [], description });
const tasks = (ids: readonly string[]): JsonValue => ({ tasks: ids.map((id) => ({ id, description: `task ${id}`, requirement_ids: [] })) });

interface Harness { readonly db: Database; readonly feed: Feed; readonly app: ReturnType<typeof createApp> }
async function setup(db: Database, grading_enabled = false): Promise<Harness> {
  for (const scope of [tenant, other]) {
    for (const question of OAKRIDGE_QUESTIONS) await registerQuestion(db, scope, question);
    await registerEvaluator(db, scope, { ...evaluator("model", MACHINE), cost_metadata: { estimated_cost_per_call: 0.01 } });
    await registerEvaluator(db, scope, human);
  }
  const feed = createFeed(db, tenant, pins);
  await feed.launch({ spec: "the spec" }, "run-1", runConfig(grading_enabled));
  return { db, feed, app: createApp({ db, credentials, profile: oakridgeProfile, capture_configuration: pins, stage_source: { read: async () => ({ ok: true, value: [
    { unit_id: "t", stage: "tasks", depends_on: [], status: { kind: "done" }, artifacts: [{ artifact_key: "tasks" }] },
    { unit_id: "i", stage: "implementation", depends_on: ["t"], status: { kind: "active" }, artifacts: [{ artifact_key: "assessment" }] },
    { unit_id: "f", stage: "integration", depends_on: ["i"], status: { kind: "not_started" }, artifacts: [{ artifact_key: "assessment" }] }
  ] }) } }) };
}
const get = async <Body>(h: Harness, path: string, token = "read"): Promise<{ status: number; body: Body }> => {
  const response = await h.app.request(path, { headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, body: await response.json() as Body };
};
const at = (revision: string, item_path: string, run = "run-1") =>
  `/v1/runs/${run}/items/at?source_revision_id=${encodeURIComponent(revision)}&item_path=${encodeURIComponent(item_path)}`;
interface Item { occurrence_id: ItemOccurrenceId; source_revision_id: string; item_path: string; stage: string; is_current: boolean; item_kind: string }
const addressed = async (h: Harness, revision: string, path: string) => (await get<Item>(h, at(revision, path))).body;
const ready = async (h: Harness, occurrence_id: ItemOccurrenceId, question_id?: string) => {
  for (const set of await readOccurrenceEvidence(h.db, tenant, occurrence_id)) {
    if (question_id && set.question_id !== question_id) continue;
    const recorded = await recordCollection(h.db, tenant, set.evidence_set_id, { state: "ready", references: [
      { source: "reported", reported_by: "agent", ref: "a", revision_id: "r" as ArtifactRevisionId, item_path: "/findings/0", content: "first" },
      { source: "reported", reported_by: "agent", ref: "b", revision_id: "r" as ArtifactRevisionId, item_path: "/findings/0", content: "second" }] });
    if (!recorded.ok) throw new Error(recorded.error.detail);
  }
};
const submit = (h: Harness, occurrence_id: string, question_id: string, submission_id: string, answer: string, extra: object = {}) =>
  h.app.request(`/v1/items/${encodeURIComponent(occurrence_id)}/answers`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer grade" },
    body: JSON.stringify({ question_id, question_version: questionVersion(question_id), submission_id, answer, ...extra }) });

interface Paged<Row> { items: Row[]; total: number; limit: number; offset: number }
interface Status {
  item: Item; is_grading_enabled: boolean; links: Paged<{ state: string; producer_local_id: string }>;
  questions: Paged<{ question: { question_id: string; allowed_values: string[] }; human: { state: string; code?: string; detail?: string };
    evidence: { evidence_set_id: string; readiness: { state: string; reason?: { code: string } }; references: Paged<{ ref: string }> };
    machine: Paged<{ measurement: { state: string; code?: string; answer?: unknown }; attempts: Paged<unknown> }>;
    answers: Paged<{ observation_id: string; reviewer_id: string | null; is_current: boolean; answer: { value: string } }>;
    superseded_answers: Paged<{ observation_id: string; is_current: boolean }> }>;
}
const status = async (h: Harness, occurrence_id: string, query = "") => (await get<Status>(h, `/v1/items/${encodeURIComponent(occurrence_id)}/status${query}`)).body;
const questionOf = (read: Status, id: string) => read.questions.items.find((question) => question.question.question_id === id)!;

integration("a finding opens by exact revision and path at every stage with no task, cohort or subject", async () => scratchDatabase(async (db) => {
  const h = await setup(db);
  await h.feed.revision({ revision_id: "analysis-1", artifact_kind: "analysis", unit_id: "run-1/analysis/one", body: analysis([{ id: "F1", description: "d", severity: "info" }]) });
  await h.feed.revision({ revision_id: "assessment-1", artifact_kind: "assessment", unit_id: "run-1/implementation/one", body: assessment([finding([], "impl")]) });
  await h.feed.revision({ revision_id: "assessment-2", artifact_kind: "assessment", unit_id: "run-1/integration/final", body: assessment([finding([], "final")]) });
  for (const [revision, stage, kind] of [["analysis-1", "analysis", "finding"], ["assessment-1", "implementation", "assessment_finding"], ["assessment-2", "integration", "assessment_finding"]] as const) {
    const read = await get<Item>(h, at(revision, "/findings/0"));
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ source_revision_id: revision, item_path: "/findings/0", stage, item_kind: kind, is_current: true });
    expect((await get(h, at(revision, "/findings/9"))).status).toBe(404);
    const state = await status(h, read.body.occurrence_id);
    expect(state.item.occurrence_id).toBe(read.body.occurrence_id);
    expect(state.links).toMatchObject({ items: [], total: 0 });
  }
  expect((await get(h, at("assessment-1", "/findings/0", "run-other"))).status).toBe(404);
  expect((await get(h, `/v1/runs/run-1/items/at?item_path=/findings/0`)).status).toBe(400);
  expect((await get(h, at("assessment-1", "/findings/0"), "other-read")).status).toBe(404);
  expect((await h.app.request(at("assessment-1", "/findings/0"))).status).toBe(403);
  expect((await get(h, at("assessment-1", "/findings/0"), "grade")).status).toBe(403);
}));

integration("explicit task links are separate from the address: empty is valid and an unknown reference stays visible", async () => scratchDatabase(async (db) => {
  const h = await setup(db);
  await h.feed.revision({ revision_id: "tasks-1", artifact_kind: "tasks", unit_id: "run-1/tasks/one", body: tasks(["T1", "T2"]) });
  await h.feed.revision({ revision_id: "assessment-1", artifact_kind: "assessment", unit_id: "run-1/implementation/one",
    body: assessment([finding(["T1", "T2"], "both"), finding([], "none"), finding(["T404"], "unknown")]) });
  const both = await addressed(h, "assessment-1", "/findings/0");
  const state = await status(h, both.occurrence_id);
  expect(state.links.items.map((link) => [link.state, link.producer_local_id]).sort()).toEqual([["resolved", "T1"], ["resolved", "T2"]]);
  const none = await addressed(h, "assessment-1", "/findings/1");
  expect((await status(h, none.occurrence_id)).links.total).toBe(0);
  const unknown = await addressed(h, "assessment-1", "/findings/2");
  expect((await status(h, unknown.occurrence_id)).links.items).toMatchObject([{ state: "unresolved", producer_local_id: "T404" }]);
  expect((await get(h, "/v1/runs/run-1/logical-items/T404")).status).toBe(404);
  expect((await get<Paged<{ item: { item_path: string } }>>(h, "/v1/runs/run-1/unresolved-references")).body.items.map((row) => row.item.item_path)).toEqual(["/findings/2"]);
  expect((await get<Paged<{ item_path: string; source_revision_id: string }>>(h, "/v1/runs/run-1/unlinked-items")).body.items).toMatchObject([{ item_path: "/findings/1", source_revision_id: "assessment-1" }, { item_path: "/findings/2", source_revision_id: "assessment-1" }]);
  const findings = (await get<Paged<{ item: { item_path: string }; links: Paged<{ producer_local_id: string }> }>>(h, "/v1/runs/run-1/gradeable-items?stage=implementation")).body;
  expect(findings.total).toBe(3);
  expect(findings.items.map((row) => [row.item.item_path, row.links.total])).toEqual([["/findings/0", 2], ["/findings/1", 0], ["/findings/2", 1]]);
  expect((await get(h, "/v1/runs/run-1/gradeable-items?stage=nope")).status).toBe(400);
}));

integration("each state of a question reads distinctly: not ready with its reason, off, pending, deferred, failed and real negative answers", async () => scratchDatabase(async (db) => {
  const h = await setup(db, false);
  await h.feed.revision({ revision_id: "assessment-1", artifact_kind: "assessment", unit_id: "run-1/implementation/one", body: assessment([finding([], "one")]) });
  const item = await addressed(h, "assessment-1", "/findings/0");
  await ready(h, item.occurrence_id, EVIDENCE_SUPPORT_ID);
  const off = await status(h, item.occurrence_id);
  expect(off.is_grading_enabled).toBe(false);
  expect(questionOf(off, CORRECTNESS_ID).human).toEqual({ state: "not_ready", code: "collection_pending", detail: "evidence has not been collected yet" });
  expect(questionOf(off, CORRECTNESS_ID).machine.items[0]?.measurement).toMatchObject({ state: "not_ready", code: "collection_pending" });
  expect(questionOf(off, EVIDENCE_SUPPORT_ID).human).toEqual({ state: "ready" });
  expect(questionOf(off, EVIDENCE_SUPPORT_ID).machine.items[0]?.measurement).toEqual({ state: "grading_off" });
  expect(questionOf(off, EVIDENCE_SUPPORT_ID).evidence.references.total).toBe(2);
  expect((await submit(h, item.occurrence_id, EVIDENCE_SUPPORT_ID, "s1", "does_not_support")).status).toBe(201);
  const negative = questionOf(await status(h, item.occurrence_id), EVIDENCE_SUPPORT_ID);
  expect(negative.answers.items).toMatchObject([{ reviewer_id: "operator", answer: { state: "answered", value: "does_not_support" }, is_current: true }]);
}));

integration("machine pending, failed and answered states read apart from negative answers", async () => scratchDatabase(async (db) => {
  const h = await setup(db, true);
  await h.feed.revision({ revision_id: "assessment-1", artifact_kind: "assessment", unit_id: "run-1/implementation/one", body: assessment([finding([], "one")]) });
  const item = await addressed(h, "assessment-1", "/findings/0");
  await ready(h, item.occurrence_id);
  expect((await admitRun(db, tenant, "run-1", { retry_limit: 0 })).ok).toBe(true);
  const pending = await status(h, item.occurrence_id);
  expect(pending.questions.items.map((question) => question.machine.items[0]?.measurement.state)).toEqual(["pending", "pending"]);
  const controls = { lease_owner: "w", lease_ms: 60_000, run_spend: 5 };
  const first = await claimNext(db, tenant, controls);
  const second = await claimNext(db, tenant, controls);
  if (first.kind !== "claimed" || second.kind !== "claimed") throw new Error("expected claims");
  await failExecution(db, tenant, first.claim, { category: "rate_limit", detail: "refused", provider_request_id: null, provider_cost: null });
  await completeExecution(db, tenant, second.claim, { answer: { state: "answered", kind: "choice", value: "contradicted" } } as never).catch(() => null);
  const settled = await status(h, item.occurrence_id);
  const states = settled.questions.items.map((question) => question.machine.items[0]?.measurement.state).sort();
  expect(states).toContain("failed");
  expect(settled.questions.items.every((question) => question.machine.items[0]?.attempts.total === 1)).toBe(true);
}));

integration("budget-deferred work reads as deferred, not as a failure or a negative answer", async () => scratchDatabase(async (db) => {
  const h = await setup(db, true);
  await h.feed.revision({ revision_id: "assessment-1", artifact_kind: "assessment", unit_id: "run-1/implementation/one", body: assessment([finding([], "one")]) });
  const item = await addressed(h, "assessment-1", "/findings/0");
  await ready(h, item.occurrence_id, CORRECTNESS_ID);
  await admitRun(db, tenant, "run-1", { retry_limit: 0 });
  await claimNext(db, tenant, { lease_owner: "w", lease_ms: 60_000, run_spend: 0 });
  expect(questionOf(await status(h, item.occurrence_id), CORRECTNESS_ID).machine.items[0]?.measurement).toEqual({ state: "budget_deferred" });
}));

integration("every list pages to its end, nested lists included, with its own window", async () => scratchDatabase(async (db) => {
  const h = await setup(db);
  await h.feed.revision({ revision_id: "tasks-1", artifact_kind: "tasks", unit_id: "run-1/tasks/one", body: tasks(["T1", "T2", "T3"]) });
  await h.feed.revision({ revision_id: "assessment-1", artifact_kind: "assessment", unit_id: "run-1/implementation/one",
    body: assessment([finding(["T1", "T2", "T3"], "wide"), finding(["T1"], "narrow")]) });
  const item = await addressed(h, "assessment-1", "/findings/0");
  await ready(h, item.occurrence_id);
  const firstAnswer = await (await submit(h, item.occurrence_id, EVIDENCE_SUPPORT_ID, "s1", "supports")).json() as { observation_id: string };
  await submit(h, item.occurrence_id, EVIDENCE_SUPPORT_ID, "s2", "does_not_support", { corrects_observation_id: firstAnswer.observation_id });
  const one = await status(h, item.occurrence_id, "?limit=1&links_limit=1&references_limit=1&pinned_evaluators_limit=1&offset=1&links_offset=2&references_offset=1&pinned_evaluators_offset=1");
  expect(one.questions).toMatchObject({ limit: 1, offset: 1, total: 2 });
  expect(one.questions.items).toHaveLength(1);
  expect(one.links).toMatchObject({ limit: 1, offset: 2, total: 3 });
  expect(one.links.items).toHaveLength(1);
  const question = one.questions.items[0]!;
  expect(question.evidence.references).toMatchObject({ limit: 1, offset: 1, total: 2, items: [{ ref: "b" }] });
  expect(question.evidence).toMatchObject({ pinned_evaluator_definition_ids: { limit: 1, offset: 1, total: 2 } });
  for (const suffix of ["?limit=0", "?links_limit=0", "?references_offset=-1", "?answers_limit=201", "?attempts_limit=x"])
    expect((await get(h, `/v1/items/${encodeURIComponent(item.occurrence_id)}/status${suffix}`)).status).toBe(400);

  const tasksPage = (await get<Paged<{ producer_local_id: string; stages: Paged<{ stage: string; answers: Paged<{ count: number; drilldown: object }>; items: object; publication: { state: string; unit_ids?: Paged<string> } }> }>>(h,
    "/v1/runs/run-1/logical-items?limit=1&offset=1&stages_limit=1&stages_offset=1")).body;
  expect(tasksPage).toMatchObject({ limit: 1, offset: 1, total: 3 });
  expect(tasksPage.items[0]?.stages).toMatchObject({ limit: 1, offset: 1, total: 3 });
  const t1 = (await get<{ stages: Paged<{ stage: string; publication: { unit_ids?: Paged<string> }; answers: Paged<{ count: number; drilldown: object }>; items: object }> }>(h, "/v1/runs/run-1/logical-items/T1?answers_limit=1")).body;
  const implementation = t1.stages.items.find((stage) => stage.stage === "implementation")!;
  expect(implementation.answers).toMatchObject({ limit: 1, total: 0 });
  expect(implementation.publication.unit_ids).toMatchObject({ total: 1 });

  const drill = (key: object, query = "") => get<Paged<{ item: { source_revision_id: string; item_path: string }; links: Paged<unknown>; questions: Paged<{ evidence: { references: Paged<{ ref: string }> }; answers: Paged<{ answer: { value: string } }>; superseded_answers: Paged<{ answer: { value: string } }> }> }>>(h,
    `/v1/runs/run-1/composite-drilldown?key=${encodeURIComponent(JSON.stringify(key))}${query}`);
  const rows = (await drill(implementation.items, "&links_limit=1&references_limit=1&superseded_answers_limit=1")).body;
  expect(rows.total).toBe(2);
  const row = rows.items[0]!;
  expect(row.item).toMatchObject({ source_revision_id: "assessment-1", item_path: "/findings/0" });
  expect(row.links).toMatchObject({ limit: 1, total: 3 });
  expect(row.links.items).toHaveLength(1);
  expect(row.questions.items[0]?.evidence.references).toMatchObject({ limit: 1, total: 2 });
  expect(row.questions.items[1]?.answers.items[0]?.answer.value).toBe("does_not_support");
  expect(row.questions.items[1]?.superseded_answers.items[0]?.answer.value).toBe("supports");
  const itemsDrill = (await drill(implementation.items, "&limit=1&offset=1")).body;
  expect(itemsDrill).toMatchObject({ limit: 1, offset: 1, total: 2 });
  expect((await get(h, `/v1/runs/run-1/composite-drilldown?key=nonsense`)).status).toBe(400);
  const malformed = await drill({ logical_item_id: "l", stage: "implementation", selector: { kind: "disagreement" } });
  expect([malformed.status, (malformed.body as unknown as { error: { code: string } }).error.code]).toEqual([400, "invalid_drilldown"]);

  const lineage = (await get<Paged<{ kind: string }> & { is_captured: boolean }>(h, "/v1/runs/run-1/logical-items/T1/lineage?limit=1")).body;
  expect(lineage).toMatchObject({ limit: 1, is_captured: true });
  expect(lineage.total).toBeGreaterThan(1);
  expect((await get<Paged<unknown>>(h, `/v1/items/${encodeURIComponent(item.occurrence_id)}/evidence?limit=1`)).body).toMatchObject({ limit: 1, total: 2 });
  const answersPage = (await get<Paged<{ is_current: boolean; reviewer_id: string }>>(h, `/v1/items/${encodeURIComponent(item.occurrence_id)}/answers?limit=1&reviewer_id=operator&question_id=${EVIDENCE_SUPPORT_ID}&question_version=${encodeURIComponent(questionVersion(EVIDENCE_SUPPORT_ID))}`)).body;
  expect(answersPage).toMatchObject({ total: 2, limit: 1 });
  expect((await get<Paged<unknown>>(h, `/v1/items/${encodeURIComponent(item.occurrence_id)}/answers?reviewer_id=nobody`)).body.total).toBe(0);
  const itemsPage = (await get<{ items: unknown[]; issues: Paged<unknown> }>(h, "/v1/runs/run-1/items?limit=1&issues_limit=1")).body;
  expect(itemsPage.issues).toMatchObject({ limit: 1 });
  for (const route of ["/v1/runs/run-1/logical-items", "/v1/runs/run-1/gradeable-items", "/v1/runs/run-1/unlinked-items", "/v1/runs/run-1/unresolved-references", "/v1/runs/run-1/items"])
    expect((await get(h, `${route}?limit=999`)).status).toBe(400);
}));

integration("tenant and capability bound every read: another tenant sees nothing, a grade or ingest credential reads nothing", async () => scratchDatabase(async (db) => {
  const h = await setup(db);
  await h.feed.revision({ revision_id: "assessment-1", artifact_kind: "assessment", unit_id: "run-1/implementation/one", body: assessment([finding(["T1"], "x")]) });
  const item = await addressed(h, "assessment-1", "/findings/0");
  const id = encodeURIComponent(item.occurrence_id);
  for (const route of [`/v1/items/${id}/status`, `/v1/items/${id}/answers`, `/v1/items/${id}/evidence`, `/v1/runs/run-1/logical-items`, `/v1/runs/run-1/gradeable-items`, `/v1/runs/run-1/unlinked-items`,
    `/v1/runs/run-1/unresolved-references`, `/v1/runs/run-1/logical-items/T1/lineage`, `/v1/runs/run-1/grading-spend`]) {
    expect({ route, status: (await get(h, route, "grade")).status }).toEqual({ route, status: 403 });
    expect({ route, status: (await h.app.request(route)).status }).toEqual({ route, status: 403 });
    const crossed = await get<{ total?: number; items?: unknown[]; executions?: Record<string, number>; requests_sent?: number }>(h, route, "other-read");
    expect(crossed.status === 404 || crossed.body.total === 0 || crossed.body.requests_sent === 0).toBe(true);
  }
}));

integration("an older revision stays inspectable, marked not current, and is left out of the current list", async () => scratchDatabase(async (db) => {
  const h = await setup(db);
  await h.feed.revision({ revision_id: "assessment-1", artifact_kind: "assessment", unit_id: "run-1/implementation/one", recorded_at: "2026-11-01T00:00:00Z", body: assessment([finding(["T1"], "old")]) });
  await h.feed.revision({ revision_id: "assessment-2", artifact_kind: "assessment", unit_id: "run-1/implementation/one", predecessor_id: "assessment-1", recorded_at: "2026-11-02T00:00:00Z", body: assessment([finding(["T1"], "new")]) });
  expect(await addressed(h, "assessment-1", "/findings/0")).toMatchObject({ is_current: false });
  expect(await addressed(h, "assessment-2", "/findings/0")).toMatchObject({ is_current: true });
  const current = (await get<Paged<{ item: { source_revision_id: string } }>>(h, "/v1/runs/run-1/gradeable-items")).body;
  expect(current.items.map((row) => row.item.source_revision_id)).toEqual(["assessment-2"]);
  const all = (await get<Paged<{ item: { source_revision_id: string } }>>(h, "/v1/runs/run-1/gradeable-items?revisions=all")).body;
  expect(all.items.map((row) => row.item.source_revision_id)).toEqual(["assessment-1", "assessment-2"]);
}));


integration("an evidence set by id is the named paged evidence read: each nested window pages, refuses a bad window and stays in its tenant", async () => scratchDatabase(async (db) => {
  const h = await setup(db);
  await h.feed.revision({ revision_id: "assessment-1", artifact_kind: "assessment", unit_id: "run-1/implementation/one", body: assessment([finding([], "x")]) });
  const item = await addressed(h, "assessment-1", "/findings/0");
  await ready(h, item.occurrence_id, EVIDENCE_SUPPORT_ID);
  const set = (await readOccurrenceEvidence(h.db, tenant, item.occurrence_id)).find((candidate) => candidate.question_id === EVIDENCE_SUPPORT_ID)!;
  interface EvidenceBody { evidence_set_id: string; question_id: string; readiness: { state: string }; references: Paged<{ ref: string }>; pinned_evaluator_definition_ids: Paged<string> }
  const route = (query = "") => `/v1/evidence-sets/${encodeURIComponent(set.evidence_set_id)}${query}`;
  const whole = await get<EvidenceBody>(h, route());
  expect(whole.status).toBe(200);
  expect(whole.body).toMatchObject({ evidence_set_id: set.evidence_set_id, question_id: EVIDENCE_SUPPORT_ID, readiness: { state: "ready" } });
  expect(whole.body.references.total).toBe(2);
  expect(whole.body.pinned_evaluator_definition_ids.total).toBe(2);
  const pages = await Promise.all([0, 1].map(async (offset) => (await get<EvidenceBody>(h, route(`?references_limit=1&references_offset=${offset}&pinned_evaluators_limit=1&pinned_evaluators_offset=${offset}`))).body));
  expect(pages.map((page) => page.references.items.map((reference) => reference.ref))).toEqual([["a"], ["b"]]);
  expect(pages.map((page) => page.references.limit)).toEqual([1, 1]);
  expect(new Set(pages.flatMap((page) => page.pinned_evaluator_definition_ids.items)).size).toBe(2);
  for (const bad of ["?references_limit=0", "?references_limit=999", "?pinned_evaluators_limit=201", "?references_offset=-1", "?pinned_evaluators_offset=x"])
    expect({ bad, status: (await get(h, route(bad))).status }).toEqual({ bad, status: 400 });
  expect((await get(h, route(), "other-read")).status).toBe(404);
  expect((await get(h, route(), "grade")).status).toBe(403);
  expect((await h.app.request(route())).status).toBe(403);
  expect((await get(h, "/v1/evidence-sets/unknown")).status).toBe(404);
}));

integration("run readiness stages include unpublished and out-of-list stages, and every stage selector rejects unknown keys", async () => scratchDatabase(async (db) => {
  const h = await setup(db);
  await h.feed.revision({ revision_id: "tasks-extra", artifact_kind: "tasks", stage: "archived_stage", body: tasks(["T1"]) });
  const stages = await get<readonly { stage: string }[]>(h, "/v1/runs/run-1/grading-stages");
  expect(stages.body.map((entry) => entry.stage)).toEqual(["tasks", "implementation", "integration", "archived_stage"]);
  const rollup = await get<{ stages: Paged<{ stage: string; state: string }> }>(h, "/v1/runs/run-1/logical-items/T1");
  expect(rollup.body.stages.items.find((stage) => stage.stage === "integration")?.state).toBe("pending");
  for (const endpoint of ["logical-items", "logical-items/T1", "gradeable-items"]) {
    expect((await get(h, `/v1/runs/run-1/${endpoint}?stage=unknown`)).status).toBe(400);
  }
  const key = { logical_item_id: "task", stage: "unknown", selector: { kind: "items" } };
  expect((await get(h, `/v1/runs/run-1/composite-drilldown?key=${encodeURIComponent(JSON.stringify(key))}`)).status).toBe(400);
  const filtered = await get<{ stages: Paged<{ stage: string }> }>(h, "/v1/runs/run-1/logical-items/T1?stage=archived_stage");
  expect(filtered.body.stages.items.map((stage) => stage.stage)).toEqual(["archived_stage"]);
}));

integration("run reads require tenant capture before reading DBOS readiness", async () => scratchDatabase(async (db) => {
  const h = await setup(db);
  const reads: string[] = [];
  const app = createApp({ db, credentials, profile: oakridgeProfile, capture_configuration: pins, stage_source: {
    read: async (run_id) => {
      reads.push(run_id);
      return { ok: true, value: [{ unit_id: "u", stage: "custom", depends_on: [], status: { kind: "not_started" }, artifacts: [] }] };
    }
  } });
  const request = (run_id: string, token = "read") => app.request(`/v1/runs/${run_id}/grading-stages`, { headers: { authorization: `Bearer ${token}` } });
  expect((await request("missing")).status).toBe(404);
  expect((await request("run-1", "other-read")).status).toBe(404);
  const drilldown = encodeURIComponent(JSON.stringify({ logical_item_id: "task", stage: "custom", selector: { kind: "items" } }));
  const foreign = ["gradeable-items?stage=custom", "gradeable-items?stage=missing", "logical-items", "logical-items/T1",
    "logical-items/T1/lineage", `composite-drilldown?key=${drilldown}`];
  for (const read of foreign) { // Existing and unknown stages answer alike for a run this tenant never captured.
    const response = await app.request(`/v1/runs/run-1/${read}`, { headers: { authorization: "Bearer other-read" } });
    expect([read, response.status]).toEqual([read, 404]);
  }
  expect(reads).toEqual([]);
  expect((await request("run-1")).status).toBe(200); // A captured launch suffices before any revision.
  await h.feed.launch(null, "null-input");
  expect((await request("null-input")).status).toBe(200);
  expect(reads).toEqual(["run-1", "null-input"]);
}));
