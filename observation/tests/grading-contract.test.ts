import { expect, test } from "bun:test";
import { createApp } from "../src/http/app";
import { listGrades, registerGradingContext } from "../src/storage/grading-store";
import { runGrade } from "../src/storage/grading-store";
import { sql } from "kysely";
import { canonicalDigest } from "canonical-json";
import { withTenant } from "../src/storage/database";
import { createLlmJudgeRunner } from "../src/runners/llm-judge";
import { createBlindAssignment } from "../src/storage/blind-assignment-store";
import { recordEligibility } from "../src/storage/eligibility-store";
import type { ItemOccurrenceId } from "../src/domain/identity";
import { tenant, question, evidence, evaluator, scratchGrading, captureProjectedFixture } from "./grading-fixture";

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL || process.env.CI === "true" ? test : test.skip;
const gradeToken = "grade-token"; const readToken = "read-token";
const headers = { authorization: `Bearer ${gradeToken}`, "content-type": "application/json" };

test("judge deadline failure retains the timeout category", async () => {
  const selected = { ...question, response_kind: "choice" as const,
    allowed_values: ["yes", "insufficient_evidence"],
    input_recipe: { judge: { rubric: "grade", evidence_refs: ["fixture"],
      max_evidence_chars: 100, target: "report" } } };
  const runner = createLlmJudgeRunner({ api_key: "test-key", base_url: "https://example.invalid",
    deadline_ms: 1, transport: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error("deadline expired");
    } });
  const result = await runner.run({ question: selected, evidence, evaluator: evaluator("model") });
  expect(result.ok ? null : result.error.category).toBe("timeout");
});

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

integration("question text and provenance expectation are pinned on new definitions", async () => scratchGrading(async (db) => {
  const pinned = { ...question, question_text: "Is the fixture relevant?",
    pinned_expectation: { definition_id: "definition-1", artifact_schema_version: "1" } };
  expect((await registerGradingContext(db, tenant, { question: pinned, evidence, evaluator: evaluator("code") })).ok).toBe(true);
  const row = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.question_definition")
    .select(["question_text", "expected_definition_id", "expected_artifact_schema_version"])
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("question_id", "=", question.question_id).executeTakeFirstOrThrow());
  expect(row).toEqual({ question_text: pinned.question_text, expected_definition_id: pinned.pinned_expectation.definition_id,
    expected_artifact_schema_version: pinned.pinned_expectation.artifact_schema_version });
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
  const app = createApp({ db, credentials: { ingest: [], read: [{ ...tenant, token: readToken }], grade: [{ ...tenant, token: gradeToken, reviewer_id: "reviewer" }] } });
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
      details: { answer: { state: "answered", kind: "boolean", value: false }, reviewer_id: "reviewer",
        origin: "human_rubric_answer" as const, collection_mode: "in_context", model_answers_visible: true, workflow_decisions_visible: false } }) });
  expect(human.status).toBe(201);
  const initialHuman = await human.json();
  const correction = await app.request("/v1/grades", { method: "POST", headers,
    body: JSON.stringify({ identity: { ...identity, evaluator_definition_id: "human", attempt_label: "correction" },
      details: { answer: { state: "answered", kind: "boolean", value: true }, reviewer_id: "reviewer",
        normalized_score: 1, decision_policy_id: "human-acceptance", decision_policy_version: "1",
        supersedes_observation_id: initialHuman.observation.observation_id,
        origin: "human_rubric_answer" as const, collection_mode: "in_context", model_answers_visible: true, workflow_decisions_visible: false } }) });
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
  const app = createApp({ db, credentials: { ingest: [], read: [], grade: [{ ...tenant, token: gradeToken, reviewer_id: "reviewer" }] } });
  expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("human") })).ok).toBe(true);
  const beta = { producer: "oakridge", namespace: "other" };
  expect((await registerGradingContext(db, beta, { question, evidence: { ...evidence, evidence_set_id: "beta-evidence" as typeof evidence.evidence_set_id },
    evaluator: { ...evaluator("human"), evaluator_definition_id: "beta-human" } })).ok).toBe(true);
  const betaId = canonicalDigest(["beta-occurrence"]);
  if (!betaId.ok) throw new Error(betaId.error.detail);
  await withTenant(db, beta, async (trx) => {
    await sql`INSERT INTO observation.source_revision (producer, namespace, revision_id, run_id, unit_id,
      artifact_kind, artifact_schema_version, definition_id, body, body_digest, recorded_at)
      VALUES (${beta.producer}, ${beta.namespace}, 'rev-beta', 'run-beta', 'unit-beta', 'brief', '1', 'definition-1',
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
        details: { answer: { state: "answered", kind: "boolean", value: true }, reviewer_id: "reviewer",
          origin: "human_rubric_answer" as const, collection_mode: "in_context", model_answers_visible: false, workflow_decisions_visible: false } }) });
    expect(response.status).toBe(422);
  }
  expect((await listGrades(db, tenant, occurrence_id, { limit: 10, offset: 0 }))?.total).toBe(0);
  const executionCount = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluation_execution")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .executeTakeFirstOrThrow());
  expect(Number(executionCount.count)).toBe(0);
}));

for (const path of ["/v1/evaluations", "/v1/evaluation-jobs"]) {
  integration(`${path} refuses unsupported provenance before registering supplied context`, async () => scratchGrading(async (db, occurrence_id) => {
    const app = createApp({ db, credentials: { ingest: [], read: [], grade: [{ ...tenant, token: gradeToken }] } });
    const unsupported = { ...question, pinned_expectation: { ...question.pinned_expectation, definition_id: "different-definition" } };
    const response = await app.request(path, { method: "POST", headers, body: JSON.stringify({
      identity: { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
        question_id: question.question_id, question_version: question.question_version,
        evaluator_definition_id: "code", config_digest: "config-1", attempt_label: "unsupported" },
      context: { question: unsupported, evidence, evaluator: evaluator("code") }, runner: "deterministic",
    }) });
    expect(response.status).toBe(422);
    expect((await response.json()).error.message).toContain('definition_id: recorded="definition-1", pinned="different-definition"');
    const rows = await withTenant(db, tenant, async (trx) => ({
      questions: await trx.selectFrom("observation.question_definition").selectAll().execute(),
      evidence: await trx.selectFrom("observation.evidence_set").selectAll().execute(),
      evaluators: await trx.selectFrom("observation.evaluator_definition").selectAll().execute(),
      executions: await trx.selectFrom("observation.evaluation_execution").selectAll().execute(),
      jobs: await trx.selectFrom("observation.grading_job").selectAll().execute(),
    }));
    expect(rows).toEqual({ questions: [], evidence: [], evaluators: [], executions: [], jobs: [] });
  }));
}

integration("the direct grading boundary never invokes the runner for unsupported provenance", async () => scratchGrading(async (db, occurrence_id) => {
  const unsupported = { ...question, pinned_expectation: { ...question.pinned_expectation, artifact_schema_version: "other-schema" } };
  expect((await registerGradingContext(db, tenant, { question: unsupported, evidence, evaluator: evaluator("code") })).ok).toBe(true);
  let calls = 0;
  const result = await runGrade(db, tenant, { identity: { subject_occurrence_id: occurrence_id,
    evidence_set_id: evidence.evidence_set_id, question_id: question.question_id, question_version: question.question_version,
    evaluator_definition_id: "code", config_digest: "config-1", attempt_label: "unsupported" },
    runner: { kind: "code", async run() { calls++; throw new Error("unsupported input reached the runner"); } } });
  expect(result).toMatchObject({ ok: false, error: { detail: 'Unsupported provenance: artifact_schema_version: recorded="1", pinned="other-schema"' } });
  expect(calls).toBe(0);
  expect(await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluation_execution").selectAll().execute())).toEqual([]);
}));

integration("later captures preserve execution, blind-assignment and grade evidence on their original revision", async () => scratchGrading(async (db) => {
  const first = await captureProjectedFixture(db, { revision_id: "brief-original", artifact_kind: "brief", body: {
    cohort_id: "cohort", decisions_made: [], approaches_rejected: [], acceptance_criteria: [{ id: "stable", text: "original" }],
  } });
  const subject = first.find((item) => item.item_kind === "criterion")!;
  const selected = { ...question, target_item_kinds: ["criterion"] };
  expect((await registerGradingContext(db, tenant, { question: selected, evidence, evaluator: evaluator("code") })).ok).toBe(true);
  const frozen = { subject_occurrence_id: subject.occurrence_id as ItemOccurrenceId, evidence_set_id: evidence.evidence_set_id,
    question_id: selected.question_id, question_version: selected.question_version };
  expect((await recordEligibility(db, tenant, { ...tenant, ...frozen, tag: "eligible", payload: { evidence_set_id: frozen.evidence_set_id } })).ok).toBe(true);
  const assignment = await createBlindAssignment(db, tenant, frozen);
  expect(assignment.ok).toBe(true);
  const graded = await runGrade(db, tenant, { identity: { ...frozen, evaluator_definition_id: "code",
    config_digest: "config-1", attempt_label: "first" }, runner: { kind: "code", async run() {
      return { ok: true, value: { answer: { state: "answered", kind: "boolean", value: true } } };
    } } });
  expect(graded.ok).toBe(true);
  const snapshot = () => withTenant(db, tenant, async (trx) => ({
    execution: await trx.selectFrom("observation.evaluation_execution")
      .select(["evidence_set_id", "subject_occurrence_id", "question_id", "question_version"]).executeTakeFirstOrThrow(),
    assignment: await trx.selectFrom("observation.blind_assignment")
      .select(["evidence_set_id", "subject_occurrence_id", "question_id", "question_version"]).executeTakeFirstOrThrow(),
  }));
  const before = await snapshot();
  const before_grades = await listGrades(db, tenant, subject.occurrence_id, { limit: 10, offset: 0 });
  const later = await captureProjectedFixture(db, { revision_id: "brief-later", predecessor_id: "brief-original",
    artifact_kind: "brief", recorded_at: "2026-11-01T02:00:00Z", body: {
      cohort_id: "cohort", decisions_made: [], approaches_rejected: [], acceptance_criteria: [{ id: "stable", text: "changed" }],
    } });
  const newer = later.find((item) => item.item_kind === "criterion")!;
  expect(newer.occurrence_id).not.toBe(subject.occurrence_id);
  expect(newer.logical_item_id).toBe(subject.logical_item_id);
  expect((await recordEligibility(db, tenant, { ...tenant, ...frozen, subject_occurrence_id: newer.occurrence_id as ItemOccurrenceId,
    tag: "eligible", payload: { evidence_set_id: frozen.evidence_set_id } })).ok).toBe(true);
  expect(JSON.stringify(await snapshot())).toBe(JSON.stringify(before));
  expect(before).toEqual({ execution: frozen, assignment: frozen });
  expect(await listGrades(db, tenant, subject.occurrence_id, { limit: 10, offset: 0 })).toEqual(before_grades);
  expect((await listGrades(db, tenant, newer.occurrence_id, { limit: 10, offset: 0 }))?.items).toEqual([]);
  const origin = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.grade_observation as g")
    .innerJoin("observation.item_occurrence as i", "i.occurrence_id", "g.subject_occurrence_id")
    .select(["i.revision_id", "g.evidence_set_id"]).executeTakeFirstOrThrow());
  expect(origin).toEqual({ revision_id: "brief-original", evidence_set_id: frozen.evidence_set_id });
}));
