import { expect, test } from "bun:test";
import { createLlmJudgeRunner } from "../src/runners/llm-judge";
import type { GradingContext } from "../src/grading/runner";
import { evidence, evaluator, question } from "./grading-fixture";

const context: GradingContext = { question: { ...question, response_kind: "choice",
  allowed_values: ["faithful", "changed", "insufficient_evidence"],
  input_recipe: { judge: { rubric: "Does the brief preserve the criterion's meaning?",
    evidence_refs: ["criterion"], max_evidence_chars: 500, target: "report" } } },
  evidence: { ...evidence, references: [{ ref: "criterion", content: "Original and brief criterion excerpts", digest: null },
    { ref: "original_assessor_verdict", content: "faithful", digest: null }] },
  evaluator: { ...evaluator("model"), evaluator_definition_id: "judge", provider: "openai",
    model: "pinned-judge", runtime_revision: "rubric-v1" } };
const answer = { choice: "changed", probabilities: { faithful: 0.12, changed: 0.68,
  insufficient_evidence: 0.2 }, confidence: 0.59 };
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
  expect(withExplanation.ok && withExplanation.value.answer).toEqual({ state: "answered", kind: "choice", value: "changed" });
  expect(withoutExplanation.ok && withoutExplanation.value.answer).toEqual({ state: "answered", kind: "choice", value: "changed" });
  if (!withExplanation.ok || !withoutExplanation.ok) return;
  expect(withExplanation.value.probabilities).toEqual(answer.probabilities);
  expect(withExplanation.value.confidence).toBe(answer.confidence);
  expect(withExplanation.value.rationale).toBe("A wording difference.");
  expect(withoutExplanation.value.rationale).toBeNull();
  expect(withExplanation.value.reproducibility_metadata).toMatchObject({ explanation_source: {
    provider: "openai", model: "pinned-judge", runtime_revision: "rubric-v1" } });
  expect(requests[0]).not.toContain("original_assessor_verdict");
  expect(requests[0]).not.toContain("faithful\",\"digest");
});

test("explicit insufficient evidence choice becomes an abstention with full distribution", async () => {
  const insufficient = { ...answer, choice: "insufficient_evidence", confidence: 0.04 };
  const runner = createLlmJudgeRunner({ api_key: "key", base_url: "https://judge.example/v1",
    transport: async () => completion(insufficient) });
  const result = await runner.run(context);
  expect(result.ok && result.value.answer).toEqual({ state: "abstain", kind: "choice", reason: "insufficient_evidence" });
  if (result.ok) expect(result.value.probabilities).toEqual(answer.probabilities);
});

test("a low-confidence non-abstain choice stays answered", async () => {
  const runner = createLlmJudgeRunner({ api_key: "key", base_url: "https://judge.example/v1",
    transport: async () => completion({ ...answer, confidence: 0.01,
      probabilities: { faithful: 0.33, changed: 0.34, insufficient_evidence: 0.33 } }) });
  const result = await runner.run(context);
  expect(result.ok && result.value.answer).toEqual({ state: "answered", kind: "choice", value: "changed" });
});

test("judge refuses an evidence recipe that exposes the original assessor verdict", async () => {
  const runner = createLlmJudgeRunner({ api_key: "key", base_url: "https://judge.example/v1",
    transport: async () => { throw new Error("should not call"); } });
  const result = await runner.run({ ...context, question: { ...context.question,
    input_recipe: { judge: { rubric: "Judge report", evidence_refs: ["original_assessor_verdict"],
      max_evidence_chars: 500, target: "report" } } } });
  expect(result).toMatchObject({ ok: false, error: { operation: "llm_judge" } });
});
