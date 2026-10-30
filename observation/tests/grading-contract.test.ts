import { expect, test } from "bun:test";
import { createApp } from "../src/http/app";
import { listGrades, registerGradingContext } from "../src/storage/grading-store";
import { runGrade } from "../src/storage/grading-store";
import { sql } from "kysely";
import { canonicalDigest } from "../src/canonical/canonical-json";
import { withTenant } from "../src/storage/database";
import { tenant, question, evidence, evaluator, scratchGrading } from "./grading-fixture";

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL || process.env.CI === "true" ? test : test.skip;
const gradeToken = "grade-token"; const readToken = "read-token";
const headers = { authorization: `Bearer ${gradeToken}`, "content-type": "application/json" };

integration("registration rejects an instruction digest that does not match its text", async () => scratchGrading(async (db) => {
  const result = await registerGradingContext(db, tenant, { question, evidence,
    evaluator: { ...evaluator("code"), prompt_digest: "forged" } });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.detail).toContain("canonical instruction text digest");
}));

integration("registration rejects a choice question without allowed values", async () => scratchGrading(async (db) => {
  const selected = { ...question, response_kind: "choice" as const, allowed_values: null };
  const result = await registerGradingContext(db, tenant, { question: selected, evidence, evaluator: evaluator("model") });
  expect(result).toMatchObject({ ok: false, error: { detail: "choice question requires allowed values" } });
  const rows = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.question_definition")
    .select("question_id").execute());
  expect(rows).toHaveLength(0);
}));

integration("question text and recipe provenance are pinned on new definitions", async () => scratchGrading(async (db) => {
  const pinned = { ...question, question_text: "Is the fixture relevant?",
    evidence_recipe_provenance: { recipe_id: "fixture", recipe_version: "v1", source: "fixture" } };
  expect((await registerGradingContext(db, tenant, { question: pinned, evidence, evaluator: evaluator("code") })).ok).toBe(true);
  const row = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.question_definition")
    .select(["question_text", "evidence_recipe_provenance"])
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("question_id", "=", question.question_id).executeTakeFirstOrThrow());
  expect(row).toEqual({ question_text: pinned.question_text, evidence_recipe_provenance: pinned.evidence_recipe_provenance });
  expect((await registerGradingContext(db, tenant, { question: { ...pinned, question_text: "Changed" },
    evidence, evaluator: evaluator("code") })).ok).toBe(false);
}));

integration("new evidence needs classification while stored older references remain readable", async () => scratchGrading(async (db, occurrence_id) => {
  const unclassified = { ...evidence, evidence_set_id: "unclassified" as typeof evidence.evidence_set_id,
    references: [{ ref: "fixture", content: "sample", digest: null }] };
  expect((await registerGradingContext(db, tenant, { question, evidence: unclassified, evaluator: evaluator("code") })).ok).toBe(false);
  expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("code") })).ok).toBe(true);
  await withTenant(db, tenant, (trx) => sql`INSERT INTO observation.evidence_set
    (producer, namespace, evidence_set_id, evidence_refs, is_incomplete, incompleteness_reason)
    VALUES (${tenant.producer}, ${tenant.namespace}, 'old-evidence', '[{"ref":"fixture","content":"sample","digest":null}]'::jsonb,
      false, NULL)`.execute(trx));
  const result = await runGrade(db, tenant, { identity: { subject_occurrence_id: occurrence_id,
    evidence_set_id: "old-evidence" as typeof evidence.evidence_set_id, question_id: question.question_id, question_version: question.question_version,
    evaluator_definition_id: "code", config_digest: "config-1", attempt_label: "old-reference" },
    runner: { kind: "code", run: async () => ({ ok: true, value: { answer: { state: "answered", kind: "boolean", value: true } } }) } });
  expect(result.ok && result.value.observation !== null).toBe(true);
}));

integration("all grading routes serve raw answers, distributions, evaluator identity, and stable pages", async () => scratchGrading(async (db, occurrence_id) => {
  const app = createApp({ db, credentials: { ingest: [], read: [{ ...tenant, token: readToken }], grade: [{ ...tenant, token: gradeToken }] } });
  const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
    question_id: question.question_id, question_version: question.question_version,
    evaluator_definition_id: "code", config_digest: "config-1", attempt_label: "first" };
  const code = await app.request("/v1/evaluations", { method: "POST", headers,
    body: JSON.stringify({ identity, context: { question: { ...question, input_recipe: { expected: "sample" } },
      evidence, evaluator: evaluator("code") }, runner: "deterministic" }) });
  expect(code.status).toBe(201);
  const codeReplay = await app.request("/v1/evaluations", { method: "POST", headers,
    body: JSON.stringify({ identity, runner: "deterministic" }) });
  expect(codeReplay.status).toBe(200);
  expect((await codeReplay.json()).execution.execution_id).toBe((await code.json()).execution.execution_id);
  const human = await app.request("/v1/grades", { method: "POST", headers,
    body: JSON.stringify({ identity: { ...identity, evaluator_definition_id: "human" },
      context: { question: { ...question, input_recipe: { expected: "sample" } }, evidence, evaluator: evaluator("human") },
      details: { answer: { state: "answered", kind: "boolean", value: false }, reviewer_id: "reviewer" } }) });
  expect(human.status).toBe(201);
  const initialHuman = await human.json();
  const correction = await app.request("/v1/grades", { method: "POST", headers,
    body: JSON.stringify({ identity: { ...identity, evaluator_definition_id: "human", attempt_label: "correction" },
      details: { answer: { state: "answered", kind: "boolean", value: true }, reviewer_id: "reviewer",
        normalized_score: 1, decision_policy_id: "human-acceptance", decision_policy_version: "1",
        supersedes_observation_id: initialHuman.observation.observation_id } }) });
  expect(correction.status).toBe(201);
  const choiceQuestion = { ...question, question_id: "handoff", response_kind: "choice", allowed_values: ["yes", "no"] } as const;
  const model = { ...evaluator("model"), attempt_controls: { answer: { state: "answered", kind: "choice", value: "yes" },
    probabilities: { yes: 0.7, no: 0.3 } } };
  const modelResponse = await app.request("/v1/evaluations", { method: "POST", headers,
    body: JSON.stringify({ identity: { ...identity, question_id: "handoff", evaluator_definition_id: "model" },
      context: { question: choiceQuestion, evidence, evaluator: model }, runner: "stub_model" }) });
  expect(modelResponse.status).toBe(201);
  const pageOne = await app.request(`/v1/items/${encodeURIComponent(occurrence_id)}/grades?limit=2&offset=0`,
    { headers: { authorization: `Bearer ${readToken}` } });
  const pageTwo = await app.request(`/v1/items/${encodeURIComponent(occurrence_id)}/grades?limit=2&offset=2`,
    { headers: { authorization: `Bearer ${readToken}` } });
  expect([pageOne.status, pageTwo.status]).toEqual([200, 200]);
  const first = await pageOne.json(); const second = await pageTwo.json();
  expect(first.total).toBe(4);
  expect(first.items).toHaveLength(2); expect(second.items).toHaveLength(2);
  const items = [...first.items, ...second.items];
  expect(new Set(items.map((item) => item.evaluator.kind))).toEqual(new Set(["code", "model", "human"]));
  const pinned = items.find((item) => item.evaluator.kind === "model");
  expect(pinned.answer).toEqual({ state: "answered", kind: "choice", value: "yes" });
  expect(pinned.observation.probabilities).toEqual({ yes: 0.7, no: 0.3 });
  expect(pinned.observation.answer_kind).toBe("choice");
  expect(pinned.observation.normalized_score).toBeNull();
  expect(pinned.execution.status).toBe("completed");
  expect(pinned.execution.evidence_set_id).toBe(evidence.evidence_set_id);
  expect(pinned.execution).toHaveProperty("external_execution_id");
  expect(pinned.execution).toHaveProperty("provider_link");
  expect(items.some((item) => item.observation.supersedes_observation_id === initialHuman.observation.observation_id)).toBe(true);
  expect(items.some((item) => item.observation.observation_id === initialHuman.observation.observation_id)).toBe(true);
  expect(items.find((item) => item.observation.supersedes_observation_id === initialHuman.observation.observation_id)
    ?.observation.decision_policy_version).toBe("1");
}));

integration("missing and cross-namespace references refuse grades without partial observations", async () => scratchGrading(async (db, occurrence_id) => {
  const app = createApp({ db, credentials: { ingest: [], read: [], grade: [{ ...tenant, token: gradeToken }] } });
  expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("human") })).ok).toBe(true);
  const beta = { producer: "oakridge", namespace: "other" };
  expect((await registerGradingContext(db, beta, { question, evidence: { ...evidence, evidence_set_id: "beta-evidence" as typeof evidence.evidence_set_id },
    evaluator: { ...evaluator("human"), evaluator_definition_id: "beta-human" } })).ok).toBe(true);
  const betaId = canonicalDigest(["beta-occurrence"]);
  if (!betaId.ok) throw new Error(betaId.error.detail);
  await withTenant(db, beta, async (trx) => {
    await sql`INSERT INTO observation.source_revision (producer, namespace, revision_id, run_id, unit_id,
      artifact_kind, artifact_schema_version, definition_bundle_id, definition_bundle_digest, body, body_digest, recorded_at)
      VALUES (${beta.producer}, ${beta.namespace}, 'rev-beta', 'run-beta', 'unit-beta', 'brief', '1', 'bundle', 'digest',
      '{}'::jsonb, ${betaId.value}, now())`.execute(trx);
    await sql`INSERT INTO observation.extractor_definition (producer, namespace, artifact_kind, schema_version,
      extractor_id, extractor_version, item_kind, item_selector) VALUES
      (${beta.producer}, ${beta.namespace}, 'brief', '1', 'fixture', '1', 'cohort_criterion', '/criterion')`.execute(trx);
    await sql`INSERT INTO observation.item_occurrence (producer, namespace, occurrence_id, revision_id, run_id,
      artifact_kind, schema_version, extractor_id, extractor_version, item_kind, item_selector, item_id_or_path, selected_value)
      VALUES (${beta.producer}, ${beta.namespace}, ${betaId.value}, 'rev-beta', 'run-beta', 'brief', '1',
      'fixture', '1', 'cohort_criterion', '/criterion', 'criterion-beta', '{}'::jsonb)`.execute(trx);
  });
  const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
    question_id: question.question_id, question_version: question.question_version,
    evaluator_definition_id: "human", config_digest: "config-1", attempt_label: "one" };
  for (const changed of [
    { subject_occurrence_id: "missing" }, { evidence_set_id: "missing" }, { evaluator_definition_id: "missing" },
    { subject_occurrence_id: betaId.value }, { evidence_set_id: "beta-evidence" }, { evaluator_definition_id: "beta-human" },
  ]) {
    const response = await app.request("/v1/grades", { method: "POST", headers,
      body: JSON.stringify({ identity: { ...identity, ...changed },
        details: { answer: { state: "answered", kind: "boolean", value: true }, reviewer_id: "reviewer" } }) });
    expect(response.status).toBe(422);
  }
  expect((await listGrades(db, tenant, occurrence_id, { limit: 10, offset: 0 }))?.total).toBe(0);
  const executionCount = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluation_execution")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .executeTakeFirstOrThrow());
  expect(Number(executionCount.count)).toBe(0);
}));
