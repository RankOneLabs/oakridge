import { targetOf } from "./grading-fixture";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ArtifactRevisionId, EvaluatorDefinitionId, ItemOccurrenceId } from "../src/domain/identity";
import { humanEvaluator } from "../src/grading/configuration";
import type { CaptureConfiguration } from "../src/grading/evidence";
import { createApp } from "../src/http/app";
import type { Credentials } from "../src/http/ingest-auth";
import { CORRECTNESS_ID, EVIDENCE_SUPPORT_ID, RELEVANCE_ID } from "./grading-fixture";
import { OAKRIDGE_QUESTIONS, questionVersion, oakridgeProfile, createFeed, evaluator, evaluatorId, integration, runConfig, scratchDatabase, tenant } from "./grading-fixture";
import { readOccurrenceEvidence, recordCollection } from "../src/storage/captured-evidence-store";
import { withTenant, type Database, type TenantScope } from "../src/storage/database";
import { registerEvaluator, registerQuestion } from "../src/storage/grading-store";

/** Every request leaving this process counts as a provider call; a submission must make none. */
const realFetch = globalThis.fetch;
let provider_calls = 0;
beforeEach(() => {
  provider_calls = 0;
  globalThis.fetch = (async () => { provider_calls++; throw new Error("provider call attempted"); }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

const other: TenantScope = { producer: "oakridge", namespace: "other-tenant" };
const credentials: Credentials = {
  ingest: [{ ...tenant, token: "ingest" }], read: [{ ...tenant, token: "read" }, { ...other, token: "other-read" }],
  grade: [{ ...tenant, token: "grade", reviewer_id: "operator" }, { ...tenant, token: "grade-b", reviewer_id: "second-reviewer" },
    { ...other, token: "other-grade", reviewer_id: "operator" }],
};
const MACHINE = "machine";
const human = (() => { const definition = humanEvaluator(); if (!definition.ok) throw new Error(definition.error.detail); return definition.value; })();
const pins: CaptureConfiguration = { pins: OAKRIDGE_QUESTIONS.map((question) => ({ scope: "per_item" as const, ...question, ...targetOf(question.question_id),
  evaluator_definition_ids: [evaluatorId(MACHINE), human.evaluator_definition_id as EvaluatorDefinitionId] })) };

async function setup(db: Database, grading_enabled = false) {
  for (const scope of [tenant, other]) {
    for (const question of OAKRIDGE_QUESTIONS) await registerQuestion(db, scope, question);
    await registerEvaluator(db, scope, evaluator("model", MACHINE));
    await registerEvaluator(db, scope, human);
  }
  const feed = createFeed(db, tenant, pins);
  await feed.launch({ spec: "the spec" }, "run-1", runConfig(grading_enabled));
  await feed.revision({ revision_id: "assessment-1", artifact_kind: "assessment", unit_id: "run-1/implementation/one",
    body: { head_sha: "abc", verdict: "pass", findings: [{ task_ids: [], status: "met", evidence: [], description: "narrow finding" }], recommended_next_actions: [] } });
  const item = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.item_occurrence").select("occurrence_id").where("item_kind", "=", "assessment_finding").executeTakeFirstOrThrow());
  const occurrence_id = item.occurrence_id as ItemOccurrenceId;
  const sets = await readOccurrenceEvidence(db, tenant, occurrence_id);
  const support = sets.find((set) => set.question_id === EVIDENCE_SUPPORT_ID)!;
  const correctness = sets.find((set) => set.question_id === CORRECTNESS_ID)!;
  const ready = (evidence_set_id: typeof support.evidence_set_id) => recordCollection(db, tenant, evidence_set_id, { state: "ready",
    references: [{ source: "reported", reported_by: "agent", ref: "subject", revision_id: "assessment-1" as ArtifactRevisionId, item_path: "/findings/0", content: "frozen" }] });
  await ready(support.evidence_set_id);
  return { app: createApp({ db, credentials, profile: oakridgeProfile }), occurrence_id, support, correctness, ready };
}
type Harness = Awaited<ReturnType<typeof setup>>;
const post = (h: Harness, body: unknown, token: string | null = "grade", occurrence_id: string = h.occurrence_id) => h.app.request(`/v1/items/${encodeURIComponent(occurrence_id)}/answers`,
  { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const answer = (submission_id: string, value: string, extra: Record<string, unknown> = {}) =>
  ({ question_id: EVIDENCE_SUPPORT_ID, question_version: questionVersion(EVIDENCE_SUPPORT_ID), submission_id, answer: value, ...extra });
const counts = (db: Database) => withTenant(db, tenant, async (trx) => ({
  executions: (await trx.selectFrom("observation.evaluation_execution").select("execution_id").execute()).length,
  observations: (await trx.selectFrom("observation.grade_observation").select("observation_id").execute()).length,
  attempts: (await trx.selectFrom("observation.grading_provider_attempt").select("attempt").execute()).length }));

integration("a read or ingest credential cannot submit, and no credential is refused the same", async () => scratchDatabase(async (db) => {
  const h = await setup(db);
  for (const token of ["read", "ingest", null]) expect((await post(h, answer("s1", "supports"), token)).status).toBe(403);
  expect(await counts(db)).toEqual({ executions: 0, observations: 0, attempts: 0 });
}));

integration("the reviewer is the credential's; no request field can name a reviewer, evaluator or evidence", async () => scratchDatabase(async (db) => {
  const h = await setup(db);
  for (const spoof of [{ reviewer_id: "someone-else" }, { evaluator_definition_id: MACHINE }, { evidence_set_id: "chosen" }, { reviewer: "x" }, { kind: "model" }])
    expect((await post(h, answer("spoof", "supports", spoof))).status).toBe(400);
  expect(await counts(db)).toEqual({ executions: 0, observations: 0, attempts: 0 });
  const response = await post(h, answer("s1", "supports"));
  expect(response.status).toBe(201);
  const body = await response.json() as Record<string, unknown>;
  expect(body).toMatchObject({ status: "recorded", reviewer_id: "operator", submission_id: "s1", evidence_set_id: h.support.evidence_set_id,
    evaluator_definition_id: human.evaluator_definition_id, occurrence_id: h.occurrence_id, answer: { state: "answered", kind: "choice", value: "supports" } });
  const b = await post(h, answer("s1", "does_not_support"), "grade-b");
  expect(await b.json()).toMatchObject({ reviewer_id: "second-reviewer", answer: { value: "does_not_support" } });
  expect(body.observation_id).not.toBe(undefined);
}));

integration("the same submission id from another reviewer is another answer; from the same reviewer it changes nothing", async () => scratchDatabase(async (db) => {
  const h = await setup(db, true);
  const first = await (await post(h, answer("s1", "supports", { rationale: "cited line says so" }))).json() as Record<string, unknown>;
  const before = await counts(db);
  const repeat = await post(h, answer("s1", "does_not_support"));
  expect(repeat.status).toBe(200);
  expect(await repeat.json()).toEqual({ ...first, status: "duplicate" });
  expect(await counts(db)).toEqual(before);
  expect(before.attempts).toBe(0);
  expect(provider_calls).toBe(0);
}));

integration("the answer must be one of the pinned question's choices", async () => scratchDatabase(async (db) => {
  const h = await setup(db);
  const refused = await post(h, answer("s1", "relevant"));
  expect(refused.status).toBe(422);
  expect(await refused.json()).toMatchObject({ error: { code: "invalid_answer", refusal: { allowed_values: ["supports", "does_not_support", "unclear"] } } });
  for (const value of ["supports"]) expect((await post(h, answer("s2", value))).status).toBe(201);
  expect((await post(h, { ...answer("s3", "unclear"), question_id: EVIDENCE_SUPPORT_ID }, "grade-b")).status).toBe(201);
}));

integration("only the selected question's readiness refuses; a ready question on the same item stays answerable with grading off", async () => scratchDatabase(async (db) => {
  const h = await setup(db, false);
  const waiting = await post(h, { question_id: CORRECTNESS_ID, question_version: questionVersion(CORRECTNESS_ID), submission_id: "c1", answer: "supported" });
  expect(waiting.status).toBe(409);
  expect(await waiting.json()).toMatchObject({ error: { code: "not_ready", refusal: { kind: "not_ready", code: "collection_pending" } } });
  expect((await post(h, answer("s1", "supports"))).status).toBe(201);
  await h.ready(h.correctness.evidence_set_id);
  expect((await post(h, { question_id: CORRECTNESS_ID, question_version: questionVersion(CORRECTNESS_ID), submission_id: "c1", answer: "contradicted" })).status).toBe(201);
}));

integration("a human answer shares the frozen evidence machine answers use", async () => scratchDatabase(async (db) => {
  const h = await setup(db);
  const body = await (await post(h, answer("s1", "supports"))).json() as { execution_id: string };
  const execution = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluation_execution").selectAll().where("execution_id", "=", body.execution_id).executeTakeFirstOrThrow());
  expect(execution).toMatchObject({ evidence_set_id: h.support.evidence_set_id, status: "completed", attempt_label: "submission:s1", evaluator_definition_id: human.evaluator_definition_id });
}));

integration("a question not pinned to the item, an unknown item and another tenant's item are refused", async () => scratchDatabase(async (db) => {
  const h = await setup(db);
  expect((await post(h, { question_id: RELEVANCE_ID, question_version: questionVersion(RELEVANCE_ID), submission_id: "r1", answer: "relevant" })).status).toBe(404);
  expect((await post(h, answer("s1", "supports"), "grade", "canonical-json/v1:missing")).status).toBe(404);
  const crossed = await post(h, answer("s1", "supports"), "other-grade");
  expect(crossed.status).toBe(404);
  expect(await counts(db)).toEqual({ executions: 0, observations: 0, attempts: 0 });
}));

integration("a correction appends a linked answer, keeps every earlier one and shares the evidence", async () => scratchDatabase(async (db) => {
  const h = await setup(db);
  const first = await (await post(h, answer("s1", "does_not_support", { rationale: "first look" }))).json() as { observation_id: string; evidence_set_id: string };
  const uncorrected = await post(h, answer("s2", "supports"));
  expect(uncorrected.status).toBe(409);
  expect(await uncorrected.json()).toMatchObject({ error: { code: "correction_required", refusal: { current_observation_id: first.observation_id } } });
  const corrected = await post(h, answer("s2", "supports", { corrects_observation_id: first.observation_id }));
  expect(corrected.status).toBe(201);
  const second = await corrected.json() as { observation_id: string; evidence_set_id: string; corrects_observation_id: string };
  expect(second).toMatchObject({ corrects_observation_id: first.observation_id, evidence_set_id: first.evidence_set_id });
  const stale = await post(h, answer("s3", "unclear", { corrects_observation_id: first.observation_id }));
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: { code: "stale_correction", refusal: { current_observation_id: second.observation_id } } });
  const grades = await (await h.app.request(`/v1/items/${encodeURIComponent(h.occurrence_id)}/grades`, { headers: { authorization: "Bearer read" } })).json() as { items: { observation: { observation_id: string; rationale: string | null } }[]; total: number };
  expect(grades.total).toBe(2);
  expect(grades.items.map((item) => item.observation.observation_id).sort()).toEqual([first.observation_id, second.observation_id].sort());
  expect(grades.items.find((item) => item.observation.observation_id === first.observation_id)?.observation.rationale).toBe("first look");
}));

integration("a correction cannot replace another reviewer's or a machine's answer", async () => scratchDatabase(async (db) => {
  const h = await setup(db);
  const theirs = await (await post(h, answer("s1", "supports"), "grade-b")).json() as { observation_id: string };
  const refused = await post(h, answer("s2", "does_not_support", { corrects_observation_id: theirs.observation_id }));
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ error: { code: "not_correctable" } });
}));

test("a grade credential names its bound reviewer; other capabilities cannot ask", async () => {
  const app = createApp({ db: {} as Database, credentials, profile: oakridgeProfile });
  const read = (token: string) => app.request("/v1/reviewer", { headers: { authorization: `Bearer ${token}` } });
  expect(await (await read("grade-b")).json()).toEqual({ reviewer_id: "second-reviewer" });
  expect((await read("read")).status).toBe(403);
});

integration("T3 and T7 have isolated subjects, evidence, executions, answers, corrections and task reads", async () => scratchDatabase(async (db) => {
  const { scopeOf } = await import("./grading-fixture");
  const { pinSubjectInTransaction, collectPinnedQuestion } = await import("../src/storage/captured-evidence-store");
  const { CaptureArtifactSource } = await import("../src/storage/capture-artifact-source");
  const { oakridgeEvidence } = await import("./grading-fixture");
  const configuration: CaptureConfiguration = { pins: OAKRIDGE_QUESTIONS.map((question) => ({ ...question, ...scopeOf(question.question_id), ...targetOf(question.question_id),
    evaluator_definition_ids: [human.evaluator_definition_id as EvaluatorDefinitionId] })) };
  for (const question of OAKRIDGE_QUESTIONS) await registerQuestion(db, tenant, question);
  await registerEvaluator(db, tenant, human);
  const feed = createFeed(db, tenant, configuration);
  await feed.launch({ spec: "the spec" });
  await feed.revision({ revision_id: "scoped", artifact_kind: "assessment", unit_id: "run-1/implementation/one",
    body: { findings: [{ task_ids: ["T3", "T7", "T7", "T99"], evidence: [], status: "met" }] } });
  const row = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.item_occurrence").selectAll()
    .where("item_kind", "=", "assessment_finding").executeTakeFirstOrThrow());
  const occurrence_id = row.occurrence_id as ItemOccurrenceId;
  expect(await readOccurrenceEvidence(db, tenant, occurrence_id)).toEqual([]);
  const task = (id: string) => `oakridge:grading-test:run-1:task:${id}` as import("../src/domain/identity").LogicalItemId;
  const taskBody = (ids: readonly string[]) => ({ tasks: ids.map((id) => ({ id, description: `Definition for ${id}`, requirement_ids: [] })) });
  await feed.revision({ revision_id: "tasks", artifact_kind: "tasks", recorded_at: "2026-11-01T00:00:01Z", body: taskBody(["T3", "T7", "T9"]) });
  const sets = await readOccurrenceEvidence(db, tenant, occurrence_id);
  expect(sets.map((set) => [set.question_id, set.task_id])).toEqual([
    [CORRECTNESS_ID, task("T3")], [CORRECTNESS_ID, task("T7")], [EVIDENCE_SUPPORT_ID, task("T3")], [EVIDENCE_SUPPORT_ID, task("T7")] ]);
  const pin = configuration.pins.find((pin) => pin.question_id === EVIDENCE_SUPPORT_ID)!;
  const refused = await withTenant(db, tenant, (trx) => pinSubjectInTransaction(trx, tenant,
    { subject: { subject_occurrence_id: occurrence_id, task_id: task("T9") }, pin }));
  expect(refused).toMatchObject({ ok: false, error: { operation: "evidence_store", entity_id: occurrence_id } });
  expect(await readOccurrenceEvidence(db, tenant, occurrence_id)).toEqual(sets);
  const source = new CaptureArtifactSource({ db, tenant, run_id: "run-1", collector: oakridgeEvidence,
    repository: { hasCommit: async () => false, readFile: async () => ({ state: "absent" }) } });
  for (const set of sets) {
    const collected = await collectPinnedQuestion(db, tenant, source, set);
    expect(collected).toMatchObject({ ok: true, value: { task_id: set.task_id, readiness: { state: "ready" } } });
    if (!collected.ok || collected.value.readiness.state !== "ready") throw new Error("collection failed");
    const context = collected.value.readiness.references.filter((reference) => reference.ref.startsWith("task_context:"));
    expect(context).toEqual([{ source: "revision", ref: "task_context:0", revision_id: "tasks" as ArtifactRevisionId,
      item_path: set.task_id === task("T3") ? "/tasks/0" : "/tasks/1",
      content: { id: set.task_id === task("T3") ? "T3" : "T7", description: set.task_id === task("T3") ? "Definition for T3" : "Definition for T7", requirement_ids: [] } }]);
  }
  const app = createApp({ db, credentials, profile: oakridgeProfile, capture_configuration: configuration });
  const send = (body: unknown) => app.request(`/v1/items/${encodeURIComponent(occurrence_id)}/answers`,
    { method: "POST", headers: { authorization: "Bearer grade", "content-type": "application/json" }, body: JSON.stringify(body) });
  const read = async (surface: string, query = "") => app.request(`/v1/items/${encodeURIComponent(occurrence_id)}/${surface}?${query}`, { headers: { authorization: "Bearer read" } });
  expect(await (await send(answer("missing", "supports"))).json()).toMatchObject({ error: { code: "task_required" } });
  expect(await (await send(answer("foreign", "supports", { task_id: task("T9") }))).json()).toMatchObject({ error: { code: "question_not_pinned" } });
  const first = await (await send(answer("t3", "supports", { task_id: task("T3") }))).json() as { observation_id: string; evidence_set_id: string; execution_id: string };
  const second = await (await send(answer("t7", "does_not_support", { task_id: task("T7") }))).json() as typeof first;
  expect(first.evidence_set_id).not.toBe(second.evidence_set_id);
  expect(first.execution_id).not.toBe(second.execution_id);
  expect((await send(answer("cross", "supports", { task_id: task("T3"), corrects_observation_id: second.observation_id }))).status).toBe(409);
  expect((await send(answer("correction", "unclear", { task_id: task("T3"), corrects_observation_id: first.observation_id }))).status).toBe(201);
  const filter = `question_id=${EVIDENCE_SUPPORT_ID}&question_version=${questionVersion(EVIDENCE_SUPPORT_ID)}`;
  for (const surface of ["answers", "evidence"]) expect((await read(surface, filter)).status).toBe(400);
  const t7answers = await (await read("answers", `${filter}&task_id=${task("T7")}`)).json() as { items: { observation_id: string; task_id: string }[] };
  expect(t7answers.items.map((answer) => [answer.observation_id, answer.task_id])).toEqual([[second.observation_id, task("T7")]]);
  for (const surface of ["status", "evidence", "grades", "lineage"]) {
    const response = await read(surface, `task_id=${task("T3")}`);
    expect(response.status).toBe(200);
    const body = await response.json() as { items?: { task_id: string }[]; questions?: { items: { task_id: string }[] }; task_id?: string };
    if (surface === "lineage") expect(body.task_id).toBe(task("T3"));
    else expect((body.items ?? body.questions?.items ?? []).every((entry) => entry.task_id === task("T3"))).toBe(true);
  }
  // Resolving the last reference creates only its two subjects and never changes existing pins.
  const next_version = "late-version";
  for (const question of OAKRIDGE_QUESTIONS.filter((question) => question.item_kind === "assessment_finding"))
    await registerQuestion(db, tenant, { ...question, question_version: next_version });
  const later_configuration: CaptureConfiguration = { pins: configuration.pins.map((pin) =>
    pin.scope === "per_task" ? { ...pin, question_version: next_version } : pin) };
  await feed.revision({ revision_id: "tasks-later", artifact_kind: "tasks", body: taskBody(["T3", "T7", "T9", "T99"]) }, later_configuration);
  const later_sets = await readOccurrenceEvidence(db, tenant, occurrence_id);
  expect(later_sets.filter((set) => set.task_id === task("T99")).map((set) => set.question_version)).toEqual([next_version, next_version]);
  expect(later_sets.filter((set) => set.task_id === task("T3")).every((set) => set.question_version !== next_version)).toBe(true);
  await feed.revision({ revision_id: "tasks-later", artifact_kind: "tasks", body: taskBody(["T3", "T7", "T9", "T99"]) }, later_configuration);
  expect(await readOccurrenceEvidence(db, tenant, occurrence_id)).toHaveLength(6);
  const per_item = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.item_occurrence").select("occurrence_id")
    .where("item_kind", "=", "task").executeTakeFirstOrThrow());
  const request = { question_id: "task.requirement_coverage", question_version: questionVersion("task.requirement_coverage"), submission_id: "bad-task", answer: "unclear", task_id: task("T3") };
  const rejected = await app.request(`/v1/items/${encodeURIComponent(per_item.occurrence_id)}/answers`, { method: "POST",
    headers: { authorization: "Bearer grade", "content-type": "application/json" }, body: JSON.stringify(request) });
  expect(await rejected.json()).toMatchObject({ error: { code: "task_not_applicable" } });
  for (const surface of ["answers", "evidence"]) {
    const response = await app.request(`/v1/items/${encodeURIComponent(per_item.occurrence_id)}/${surface}?question_id=task.requirement_coverage&question_version=${request.question_version}&task_id=${task("T3")}`,
      { headers: { authorization: "Bearer read" } });
    expect(response.status).toBe(400);
  }
  expect(provider_calls).toBe(0);
}));

integration("empty task_ids pins one task-less subject; unresolved ids wait and later gain tasked subjects", async () => scratchDatabase(async (db) => {
  const { committedDefinitions, oakridgeGradingRegistry, oakridgeEvidence } = await import("./grading-fixture");
  const { planRegistration } = await import("../src/grading/configuration");
  const { registerDefinitions } = await import("../src/storage/grading-store");
  const { collectPinnedQuestion } = await import("../src/storage/captured-evidence-store");
  const { CaptureArtifactSource } = await import("../src/storage/capture-artifact-source");
  const registration = planRegistration(await committedDefinitions(), oakridgeGradingRegistry);
  if (!registration.ok) throw new Error(registration.error.detail);
  await registerDefinitions(db, tenant, registration.value);
  const feed = createFeed(db, tenant, registration.value.capture);
  await feed.launch({ spec: "the spec" });
  await feed.revision({ revision_id: "assessment", artifact_kind: "assessment", body: { findings: [
    { task_ids: [], evidence: [], description: "General finding" },
    { task_ids: ["T404"], evidence: [], description: "Unresolved finding" }] } });
  const items = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.item_occurrence").selectAll()
    .where("item_kind", "=", "assessment_finding").orderBy("json_pointer").execute());
  const empty = items[0]!.occurrence_id as ItemOccurrenceId;
  const unresolved = items[1]!.occurrence_id as ItemOccurrenceId;
  const pinned = await readOccurrenceEvidence(db, tenant, empty);
  expect(pinned.map((set) => [set.question_id, set.task_id])).toEqual([[CORRECTNESS_ID, null], [EVIDENCE_SUPPORT_ID, null]]);
  expect(await readOccurrenceEvidence(db, tenant, unresolved)).toEqual([]);
  expect(await withTenant(db, tenant, (trx) => trx.selectFrom("observation.item_relation").select("unresolved_target_ref")
    .where("source_occurrence_id", "=", unresolved).execute())).toMatchObject([{ unresolved_target_ref: expect.stringContaining("T404") }]);
  const source = new CaptureArtifactSource({ db, tenant, run_id: "run-1", collector: oakridgeEvidence,
    repository: { hasCommit: async () => false, readFile: async () => ({ state: "absent" }) } });
  for (const set of pinned) {
    const result = await collectPinnedQuestion(db, tenant, source, set);
    expect(result).toMatchObject({ ok: true, value: { task_id: null, readiness: { state: "ready", references: [{ ref: "subject" }] } } });
  }
  const app = createApp({ db, credentials, profile: oakridgeProfile, capture_configuration: registration.value.capture });
  const send = (occurrence: string, body: unknown) => app.request(`/v1/items/${encodeURIComponent(occurrence)}/answers`,
    { method: "POST", headers: { authorization: "Bearer grade", "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await send(empty, answer("taskless", "supports", { task_id: null }))).status).toBe(201);
  expect(await (await send(unresolved, answer("unresolved", "supports", { task_id: null }))).json()).toMatchObject({ error: { code: "task_required" } });
  expect((await send(empty, answer("invalid-value", "invented"))).status).toBe(422);
  const filter = `question_id=${EVIDENCE_SUPPORT_ID}&question_version=${questionVersion(EVIDENCE_SUPPORT_ID)}`;
  for (const surface of ["answers", "evidence"]) {
    const read = (query: string) => app.request(`/v1/items/${encodeURIComponent(empty)}/${surface}?${query}`, { headers: { authorization: "Bearer read" } });
    expect((await read(filter)).status).toBe(200);
    expect((await read(`${filter}&task_id=T404`)).status).toBe(400);
  }
  await feed.revision({ revision_id: "tasks", artifact_kind: "tasks", body: { tasks: [{ id: "T404", description: "Resolved", requirement_ids: [] }] } });
  const resolved = await readOccurrenceEvidence(db, tenant, unresolved);
  expect(resolved.map((set) => set.task_id)).toEqual([expect.stringContaining("T404"), expect.stringContaining("T404")]);
  expect(await readOccurrenceEvidence(db, tenant, empty)).toHaveLength(2);
  expect(provider_calls).toBe(0);
}));
