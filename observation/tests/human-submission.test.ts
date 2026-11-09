import { afterEach, beforeEach, expect, test } from "bun:test";
import type { EvaluatorDefinitionId, ItemOccurrenceId } from "../src/domain/identity";
import { humanEvaluator } from "../src/grading/configuration";
import type { CaptureConfiguration } from "../src/grading/evidence";
import { createApp } from "../src/http/app";
import type { Credentials } from "../src/http/ingest-auth";
import { CORRECTNESS_ID, EVIDENCE_SUPPORT_ID, OAKRIDGE_QUESTIONS, RELEVANCE_ID } from "../src/producers/oakridge/questions";
import { oakridgeProfile } from "../src/producers/oakridge/profile";
import { readOccurrenceEvidence, recordCollection } from "../src/storage/captured-evidence-store";
import { withTenant, type Database, type TenantScope } from "../src/storage/database";
import { registerEvaluator, registerQuestion } from "../src/storage/grading-store";
import { createFeed, evaluator, evaluatorId, integration, runConfig, scratchDatabase, tenant } from "./grading-fixture";

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
const pins: CaptureConfiguration = { pins: OAKRIDGE_QUESTIONS.map((question) => ({ ...question,
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
    references: [{ source: "reported", reported_by: "agent", ref: "subject", revision_id: "assessment-1", item_path: "/findings/0", content: "frozen" }] });
  await ready(support.evidence_set_id);
  return { app: createApp({ db, credentials, profile: oakridgeProfile }), occurrence_id, support, correctness, ready };
}
type Harness = Awaited<ReturnType<typeof setup>>;
const post = (h: Harness, body: unknown, token: string | null = "grade", occurrence_id: string = h.occurrence_id) => h.app.request(`/v1/items/${encodeURIComponent(occurrence_id)}/answers`,
  { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const answer = (submission_id: string, value: string, extra: Record<string, unknown> = {}) =>
  ({ question_id: EVIDENCE_SUPPORT_ID, question_version: "1", submission_id, answer: value, ...extra });
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
  const waiting = await post(h, { question_id: CORRECTNESS_ID, question_version: "1", submission_id: "c1", answer: "supported" });
  expect(waiting.status).toBe(409);
  expect(await waiting.json()).toMatchObject({ error: { code: "not_ready", refusal: { kind: "not_ready", code: "collection_pending" } } });
  expect((await post(h, answer("s1", "supports"))).status).toBe(201);
  await h.ready(h.correctness.evidence_set_id);
  expect((await post(h, { question_id: CORRECTNESS_ID, question_version: "1", submission_id: "c1", answer: "contradicted" })).status).toBe(201);
}));

integration("a human answer shares the frozen evidence machine answers use", async () => scratchDatabase(async (db) => {
  const h = await setup(db);
  const body = await (await post(h, answer("s1", "supports"))).json() as { execution_id: string };
  const execution = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluation_execution").selectAll().where("execution_id", "=", body.execution_id).executeTakeFirstOrThrow());
  expect(execution).toMatchObject({ evidence_set_id: h.support.evidence_set_id, status: "completed", attempt_label: "submission:s1", evaluator_definition_id: human.evaluator_definition_id });
}));

integration("a question not pinned to the item, an unknown item and another tenant's item are refused", async () => scratchDatabase(async (db) => {
  const h = await setup(db);
  expect((await post(h, { question_id: RELEVANCE_ID, question_version: "1", submission_id: "r1", answer: "relevant" })).status).toBe(404);
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
