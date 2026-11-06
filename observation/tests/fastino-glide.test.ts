import { expect, test } from "bun:test";
import { createFastinoGlideRunner } from "../src/runners/fastino-glide";
import { instructionDigest } from "../src/grading/evaluator";
import type { GradingContext } from "../src/grading/runner";
import { evidence, evaluator, question } from "./grading-fixture";

const recipe = { system_one: { type: "choice", instructions: "Does the claim match?", criteria: { yes: "matches", no: "differs", insufficient_evidence: "cannot tell" } } };
const context: GradingContext = { question: { ...question, response_kind: "choice",
  allowed_values: ["yes", "no", "insufficient_evidence"], unclear_semantics: "Choose insufficient_evidence when unclear" },
  evidence, evaluator: { ...evaluator("model"), evaluator_definition_id: "glide", provider: "fastino",
    model: "fastino/glide", instruction_text: JSON.stringify(recipe), prompt_digest: instructionDigest(JSON.stringify(recipe)) } };
const answer = { type: "choice", choice: "no", probabilities: { yes: 0.2, no: 0.5,
  insufficient_evidence: 0.3 }, confidence: 0.36 };
const payload = { model: "fastino/glide", answers: { [question.question_id]: answer },
  usage: { input_tokens: 15, output_tokens: 3 } };

test("GLiDE direct fallback preserves its own model pin and raw distribution", async () => {
  const runner = createFastinoGlideRunner({ api_key: "key", base_url: "https://api.fastino.ai/v1", transport: async (url, init) => {
    expect(url).toBe("https://api.fastino.ai/v1/systemone");
    expect(JSON.parse(String(init.body)).model).toBe("fastino/glide");
    return Response.json(payload);
  } });
  const result = await runner.run(context);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.answer).toEqual({ state: "answered", kind: "choice", value: "no" });
  expect(result.value.probabilities).toEqual(answer.probabilities);
  expect(result.value.confidence).toBe(answer.confidence);
  expect(result.value.model_usage).toEqual(payload.usage);
});

test("a flat, low-confidence GLiDE distribution remains an answered choice", async () => {
  const flat = { ...answer, choice: "yes", probabilities: { yes: 0.34, no: 0.33,
    insufficient_evidence: 0.33 }, confidence: 0.01 };
  const runner = createFastinoGlideRunner({ api_key: "key", base_url: "https://api.fastino.ai/v1", transport: async () => Response.json({ ...payload,
    answers: { [question.question_id]: flat } }) });
  const result = await runner.run(context);
  expect(result.ok && result.value.answer).toEqual({ state: "answered", kind: "choice", value: "yes" });
  if (result.ok) expect(result.value.confidence).toBe(0.01);
});

test("GLiDE maps the question-designated option to unclear", async () => {
  const insufficient = { ...answer, choice: "insufficient_evidence" };
  const runner = createFastinoGlideRunner({ api_key: "key", base_url: "https://api.fastino.ai/v1", transport: async () => Response.json({ ...payload,
    answers: { [question.question_id]: insufficient } }) });
  const result = await runner.run(context);
  expect(result.ok && result.value.answer).toEqual({ state: "unclear", kind: "choice", reason: "insufficient_evidence" });
  if (result.ok) expect(result.value.probabilities).toEqual(insufficient.probabilities);
});
