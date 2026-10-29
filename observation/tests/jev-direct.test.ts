import { expect, test } from "bun:test";
import { createJevDirectRunner } from "../src/runners/jev-direct";
import { listGrades, readExecution, registerGradingContext, runGrade } from "../src/storage/grading-store";
import type { GradingContext } from "../src/grading/runner";
import { evidence, evaluator, question, scratchGrading, tenant } from "./grading-fixture";

const recipe = { system_one: { type: "choice", instructions: "Classify evidence", criteria: {
  faithful: "Meaning preserved", changed: "Meaning changed", insufficient_evidence: "Not enough evidence" } } };
const context: GradingContext = { question: { ...question, response_kind: "choice",
  allowed_values: ["faithful", "changed", "insufficient_evidence"], input_recipe: recipe },
  evidence, evaluator: { ...evaluator("model"), evaluator_definition_id: "jev", provider: "typesafe",
    model: "jev-1.13.0" } };
const answer = { type: "choice", choice: "faithful", probabilities: {
  faithful: 0.62, changed: 0.22, insufficient_evidence: 0.16 }, confidence: 0.41 };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const provider = (value: unknown) => ({ model: "jev-1.13.0", answers: { [question.question_id]: value },
  usage: { input_tokens: 31, output_tokens: 7 } });

test("Jev Choice retains every raw option probability and provider confidence", async () => {
  const runner = createJevDirectRunner("key", async (_url, init) => {
    const request = JSON.parse(String(init.body));
    expect(request.state.fixture).toBe("sample");
    return response(provider(answer));
  });
  const result = await runner.run(context);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.answer).toEqual({ state: "answered", kind: "choice", value: "faithful" });
  expect(result.value.probabilities).toEqual(answer.probabilities);
  expect(result.value.confidence).toBe(answer.confidence);
  expect(result.value.model_usage).toEqual({ input_tokens: 31, output_tokens: 7 });
  expect(result.value.reproducibility_metadata).toMatchObject({ raw_answer: answer });
});

test("Jev Score keeps fractional level, legend and full level distribution", async () => {
  const score = { type: "score", score: 1.35, legend: { "0": "poor", "1": "partial", "2": "good" },
    probabilities: { "0": 0.05, "1": 0.55, "2": 0.4 }, confidence: 0.73 };
  const runner = createJevDirectRunner("key", async () => response(provider(score)));
  const result = await runner.run({ ...context, question: { ...context.question, response_kind: "structured",
    allowed_values: null, input_recipe: { system_one: { type: "score", instructions: "Rate", criteria: ["poor", "partial", "good"] } } } });
  expect(result.ok).toBe(true);
  if (!result.ok || result.value.answer.state !== "answered" || result.value.answer.kind !== "structured") return;
  expect(result.value.answer.value).toMatchObject({ ...score, expected_level: 1.35,
    rubric_level_distribution: [{ level: "0", probability: 0.05 }, { level: "1", probability: 0.55 }, { level: "2", probability: 0.4 }] });
  expect(result.value.probabilities).toEqual(score.probabilities);
  expect(result.value.confidence).toBe(0.73);
});

test("Jev Yes/No records P(true) rather than a boolean pass", async () => {
  const runner = createJevDirectRunner("key", async () => response(provider({ type: "noul", noul: 0.37 })));
  const result = await runner.run({ ...context, question: { ...context.question, response_kind: "numeric",
    allowed_values: null, input_recipe: { system_one: { type: "noul", instructions: "Is it faithful?" } } } });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.answer).toEqual({ state: "answered", kind: "numeric", value: 0.37 });
  expect(result.value.probabilities).toEqual({ true: 0.37, false: 0.63 });
});

test("transport, status and response validation failures are Result errors", async () => {
  const runners = [
    createJevDirectRunner("key", async () => { throw new Error("secret"); }),
    createJevDirectRunner("key", async () => response({}, 503)),
    createJevDirectRunner("key", async () => response(provider({ type: "choice", choice: "faithful" }))),
  ];
  for (const runner of runners) {
    const result = await runner.run(context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ operation: "jev_direct", entity_id: "jev" });
  }
});

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
integration("stored model grade has no normalized score and a failed call creates only a readable execution", async () => scratchGrading(async (db, occurrence_id) => {
  const registered = await registerGradingContext(db, tenant, context);
  expect(registered.ok).toBe(true);
  const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
    question_id: context.question.question_id, question_version: context.question.question_version,
    evaluator_definition_id: "jev", config_digest: context.evaluator.config_digest, attempt_label: "success" };
  const passed = await runGrade(db, tenant, { identity, runner: createJevDirectRunner("key", async () => response(provider(answer))) });
  expect(passed.ok).toBe(true);
  if (!passed.ok) return;
  expect(passed.value.observation?.answer_payload).toEqual({ state: "answered", kind: "choice", value: "faithful" });
  expect(passed.value.observation?.probabilities).toEqual(answer.probabilities);
  expect(passed.value.observation?.confidence).toBe(answer.confidence);
  expect([passed.value.observation?.normalized_score, passed.value.observation?.decision_policy_id,
    passed.value.observation?.decision_policy_version]).toEqual([null, null, null]);
  const failed = await runGrade(db, tenant, { identity: { ...identity, attempt_label: "failure" },
    runner: createJevDirectRunner("key", async () => response({}, 503)) });
  expect(failed.ok).toBe(true);
  if (!failed.ok) return;
  expect(failed.value.execution.status).toBe("failed");
  expect(failed.value.execution.error).not.toBeNull();
  expect(failed.value.execution.ended_at).not.toBeNull();
  expect(failed.value.observation).toBeNull();
  expect((await readExecution(db, tenant, failed.value.execution.execution_id))?.status).toBe("failed");
  expect((await listGrades(db, tenant, occurrence_id, { limit: 10, offset: 0 }))?.total).toBe(1);
}));
