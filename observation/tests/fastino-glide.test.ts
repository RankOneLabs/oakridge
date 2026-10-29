import { expect, test } from "bun:test";
import { createFastinoGlideRunner } from "../src/runners/fastino-glide";
import { fastinoCustomUpstream, probeFastinoAuthentication } from "../src/langfuse/custom-upstream";
import { ingestModelScore } from "../src/langfuse/score-ingestion";
import type { LangfuseHttpClient } from "../src/langfuse/http-client";
import type { GradingContext } from "../src/grading/runner";
import { evidence, evaluator, question } from "./grading-fixture";

const context: GradingContext = { question: { ...question, response_kind: "choice",
  allowed_values: ["yes", "no", "insufficient_evidence"],
  input_recipe: { system_one: { type: "choice", instructions: "Does the claim match?",
    criteria: { yes: "matches", no: "differs", insufficient_evidence: "cannot tell" } } } },
  evidence, evaluator: { ...evaluator("model"), evaluator_definition_id: "glide", provider: "fastino",
    model: "fastino/glide" } };
const answer = { type: "choice", choice: "no", probabilities: { yes: 0.2, no: 0.5,
  insufficient_evidence: 0.3 }, confidence: 0.36 };
const payload = { model: "fastino/glide", answers: { [question.question_id]: answer },
  usage: { input_tokens: 15, output_tokens: 3 } };

test("GLiDE direct fallback preserves its own model pin and raw distribution", async () => {
  const runner = createFastinoGlideRunner("key", async (url, init) => {
    expect(url).toBe("https://api.fastino.ai/v1/systemone");
    expect(JSON.parse(String(init.body)).model).toBe("fastino/glide");
    return Response.json(payload);
  });
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
  const runner = createFastinoGlideRunner("key", async () => Response.json({ ...payload,
    answers: { [question.question_id]: flat } }));
  const result = await runner.run(context);
  expect(result.ok && result.value.answer).toEqual({ state: "answered", kind: "choice", value: "yes" });
  if (result.ok) expect(result.value.confidence).toBe(0.01);
});

test("GLiDE turns its explicit insufficient_evidence choice into an abstention", async () => {
  const insufficient = { ...answer, choice: "insufficient_evidence" };
  const runner = createFastinoGlideRunner("key", async () => Response.json({ ...payload,
    answers: { [question.question_id]: insufficient } }));
  const result = await runner.run(context);
  expect(result.ok && result.value.answer).toEqual({ state: "abstain", kind: "choice", reason: "insufficient_evidence" });
  if (result.ok) expect(result.value.probabilities).toEqual(insufficient.probabilities);
});

test("Fastino probe tries both authentication headers and reports measured results", async () => {
  const headers: string[] = [];
  const result = await probeFastinoAuthentication("key", "fastino/glide", async (_url, init) => {
    const selected = new Headers(init.headers);
    headers.push(selected.has("Authorization") ? "bearer" : "x-api-key");
    return selected.has("Authorization") ? Response.json({ ...payload, answers: { probe: answer } })
      : new Response("denied", { status: 401 });
  });
  expect(headers).toEqual(["bearer", "x-api-key"]);
  expect(result).toMatchObject({ ok: true, value: { bearer: "accepted", x_api_key: "rejected",
    accepted_model: "fastino/glide" } });
  expect(fastinoCustomUpstream("fastino/glide", "bearer").base_url).toBe("https://api.fastino.ai/v1");
});

test("Scores API ingestion labels a raw GLiDE reading and retains metadata", async () => {
  let sent: unknown;
  const client: LangfuseHttpClient = { async request(input) {
    sent = input;
    return { ok: true, value: { id: "local-grade-id" } as never };
  }, async text() { throw new Error("unused"); } };
  const result = await ingestModelScore(client, { score_id: "local-grade-id", trace_id: "trace",
    external_observation_id: "observation", question_id: "relevance", question_version: "1",
    evaluator_definition_id: "glide", provider: "fastino", model: "fastino/glide",
    answer: { state: "answered", kind: "choice", value: "no" }, probabilities: answer.probabilities,
    confidence: answer.confidence });
  expect(result).toEqual({ ok: true, value: "local-grade-id" });
  expect(sent).toMatchObject({ method: "POST", path: "/api/public/scores", body: {
    id: "local-grade-id", traceId: "trace", observationId: "observation",
    name: "relevance@1/raw", value: "no", dataType: "CATEGORICAL", metadata: {
      probabilities: answer.probabilities, confidence: answer.confidence, normalized: false,
      score_mapping_version: "raw-model-answer/v1" } } });
});
