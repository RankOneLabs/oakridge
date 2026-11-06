import { expect, test } from "bun:test";
import { createLlmJudgeRunner } from "../src/runners/llm-judge";
import type { GradingContext } from "../src/grading/runner";
import { evidence, evaluator, question } from "./grading-fixture";

const instruction = JSON.stringify({ rubric: "Does the evidence support the claim?", max_evidence_chars: 500 });
const context: GradingContext = { question: { ...question, response_kind: "choice",
  allowed_values: ["supported", "contradicted", "unclear"] },
  evidence: { ...evidence, references: [{ source: "reported", reported_by: "agent", ref: "citation", content: "Reported excerpt" }] },
  evaluator: { ...evaluator("model"), evaluator_definition_id: "judge", provider: "openai",
    model: "pinned-judge", runtime_revision: "rubric-v1", instruction_text: instruction } };
const answer = { choice: "contradicted", probabilities: { supported: 0.12, contradicted: 0.68, unclear: 0.2 }, confidence: 0.59 };
function completion(value: unknown) { return Response.json({ id: "completion-1", model: "pinned-judge",
  choices: [{ message: { content: JSON.stringify(value) } }],
  usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 } }); }

test("judge answer is independent of explanation and records its pinned source", async () => {
  const requests: string[] = [];
  const runner = createLlmJudgeRunner({ api_key: "key", base_url: "https://judge.example/v1",
    transport: async (_url, init) => {
      requests.push(String(init.body));
      return completion({ ...answer, explanation: requests.length === 1 ? "A wording difference." : undefined });
    } });
  const withExplanation = await runner.run(context);
  const withoutExplanation = await runner.run(context);
  expect(withExplanation.ok && withExplanation.value.answer).toEqual({ state: "answered", kind: "choice", value: "contradicted" });
  expect(withoutExplanation.ok && withoutExplanation.value.answer).toEqual({ state: "answered", kind: "choice", value: "contradicted" });
  if (!withExplanation.ok || !withoutExplanation.ok) return;
  expect(withExplanation.value.probabilities).toEqual(answer.probabilities);
  expect(withExplanation.value.confidence).toBe(answer.confidence);
  expect(withExplanation.value.rationale).toBe("A wording difference.");
  expect(withoutExplanation.value.rationale).toBeNull();
  expect(withExplanation.value.reproducibility_metadata).toMatchObject({ explanation_source: {
    provider: "openai", model: "pinned-judge", runtime_revision: "rubric-v1" } });
  expect(requests[0]).toContain("Reported excerpt");
});

test("an unclear choice records unclear with its full distribution", async () => {
  const unclear = { ...answer, choice: "unclear", confidence: 0.04 };
  const runner = createLlmJudgeRunner({ api_key: "key", base_url: "https://judge.example/v1",
    transport: async () => completion(unclear) });
  const result = await runner.run(context);
  expect(result.ok && result.value.answer).toEqual({ state: "unclear", kind: "choice", reason: "unclear" });
  if (result.ok) expect(result.value.probabilities).toEqual(answer.probabilities);
});

test("a low-confidence non-abstain choice stays answered", async () => {
  const runner = createLlmJudgeRunner({ api_key: "key", base_url: "https://judge.example/v1",
    transport: async () => completion({ ...answer, confidence: 0.01,
      probabilities: { supported: 0.33, contradicted: 0.34, unclear: 0.33 } }) });
  const result = await runner.run(context);
  expect(result.ok && result.value.answer).toEqual({ state: "answered", kind: "choice", value: "contradicted" });
});

test("judge refuses evidence over its pinned bound, and an unusable instruction, before any request", async () => {
  const runner = createLlmJudgeRunner({ api_key: "key", base_url: "https://judge.example/v1",
    transport: async () => { throw new Error("should not call"); } });
  const oversized = await runner.run({ ...context, evaluator: { ...context.evaluator,
    instruction_text: JSON.stringify({ rubric: "Judge", max_evidence_chars: 5 }) } });
  const unusable = await runner.run({ ...context, evaluator: { ...context.evaluator, instruction_text: "not json" } });
  expect(oversized).toMatchObject({ ok: false, error: { detail: "judge evidence exceeds its pinned bound" } });
  expect(unusable).toMatchObject({ ok: false, error: { detail: "judge instruction is invalid" } });
});

test("judge HTTP failure preserves its provider request id", async () => {
  const runner = createLlmJudgeRunner({ api_key: "key", base_url: "https://judge.example/v1",
    transport: async () => new Response("unavailable", { status: 503,
      headers: { "x-request-id": "judge-request-1" } }) });
  const result = await runner.run(context);
  expect(result).toMatchObject({ ok: false, error: {
    external_execution_id: "judge-request-1", detail: "judge HTTP 503" } });
});
