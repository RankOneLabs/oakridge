import { expect, test } from "bun:test";
import { createJevDirectRunner, createSystemOneRunner } from "../src/runners/jev-direct";
import type { GradingContext } from "../src/grading/runner";
import { instructionDigest } from "../src/grading/evaluator";
import { evidence, evaluator, question } from "./grading-fixture";

const recipe = { system_one: { type: "choice", instructions: "Classify evidence", criteria: {
  faithful: "Meaning preserved", changed: "Meaning changed", insufficient_evidence: "Not enough evidence" } } };
const context: GradingContext = { question: { ...question, response_kind: "choice",
  allowed_values: ["faithful", "changed", "insufficient_evidence"], unclear_semantics: "Choose insufficient_evidence when unclear" },
  evidence, evaluator: { ...evaluator("model"), evaluator_definition_id: "jev", provider: "typesafe",
    model: "jev-1.13.0", instruction_text: JSON.stringify(recipe), prompt_digest: instructionDigest(JSON.stringify(recipe)) } };
const answer = { type: "choice", choice: "faithful", probabilities: {
  faithful: 0.62, changed: 0.22, insufficient_evidence: 0.16 }, confidence: 0.41 };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const provider = (value: unknown) => ({ model: "jev-1.13.0", answers: { [question.question_id]: value },
  usage: { input_tokens: 31, output_tokens: 7 } });

test("System One transport receives a required abort deadline", async () => {
  const runner = createSystemOneRunner({ operation: "deadline-test", base_url: "https://example.invalid",
    api_key: "key", deadline_ms: 10, transport: async (_url, init) => new Promise<Response>((_resolve, reject) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }) });
  const result = await runner.run(context);
  expect(result).toMatchObject({ ok: false, error: { category: "timeout" } });
});

test("a deadline while reading the provider body is a timeout", async () => {
  const runner = createJevDirectRunner({ api_key: "key", base_url: "https://stub.invalid/v1", deadline_ms: 10,
    transport: async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init.signal!.addEventListener("abort", () => controller.error(new Error("body aborted")), { once: true });
      },
    })) });
  const result = await runner.run(context);
  expect(result).toMatchObject({ ok: false, error: { category: "timeout" } });
});

test("provider failures retain categories before and after a request", async () => {
  const cases = [
    { category: "invalid_response", api_key: "key", transport: async () => response(provider({ ...answer, choice: "unknown" })) },
    { category: "invalid_response", api_key: "key", transport: async () => response({ answers: {} }) },
    { category: "rate_limit", api_key: "key", transport: async () => response({}, 429) },
    { category: "timeout", api_key: "key", transport: async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }) },
    { category: "unconfigured_credential", api_key: undefined, transport: async () => { throw new Error("must not send"); } },
  ];
  for (const entry of cases) {
    const result = await createJevDirectRunner({ api_key: entry.api_key, base_url: "https://stub.invalid/v1",
      transport: entry.transport, deadline_ms: 5 }).run(context);
    expect(result).toMatchObject({ ok: false, error: { category: entry.category } });
  }
  const transport = await createJevDirectRunner({ api_key: "key", base_url: "https://stub.invalid/v1",
    transport: async () => { throw new Error("refused"); } }).run(context);
  expect(transport).toMatchObject({ ok: false, error: { category: "transport" } });
});

test("an out-of-vocabulary provider choice retains its reported charge", async () => {
  const runner = createJevDirectRunner({ api_key: "key", base_url: "https://stub.invalid/v1",
    transport: async () => response({ ...provider({ ...answer, choice: "unknown" }), cost: 0.4, id: "invalid-choice-request" }) });
  const result = await runner.run(context);
  expect(result).toMatchObject({ ok: false, error: { category: "invalid_response", cost: 0.4,
    external_execution_id: "invalid-choice-request" } });
});

test("provider modules do not read environment at import", async () => {
  for (const path of ["src/runners/jev-direct.ts", "src/runners/fastino-glide.ts"]) {
    const source = await Bun.file(new URL(`../${path}`, import.meta.url)).text();
    expect(source).not.toContain("process.env");
  }
});

test("Jev Choice retains every raw option probability and provider confidence", async () => {
  const runner = createJevDirectRunner({ api_key: "key", base_url: "https://api.typesafe.ai/v1", transport: async (_url, init) => {
    const request = JSON.parse(String(init.body));
    expect(request.state.fixture).toBe("sample");
    return response(provider(answer));
  } });
  const result = await runner.run(context);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.answer).toEqual({ state: "answered", kind: "choice", value: "faithful" });
  expect(result.value.probabilities).toEqual(answer.probabilities);
  expect(result.value.confidence).toBe(answer.confidence);
  expect(result.value.model_usage).toEqual({ input_tokens: 31, output_tokens: 7 });
  expect(result.value.reproducibility_metadata).toMatchObject({ raw_answer: answer });
});

test("Jev maps the question-designated unclear choice to unclear", async () => {
  const insufficient = { ...answer, choice: "insufficient_evidence" };
  const runner = createJevDirectRunner({ api_key: "key", base_url: "https://api.typesafe.ai/v1", transport: async () => response(provider(insufficient)) });
  const result = await runner.run(context);
  expect(result.ok && result.value.answer).toEqual({ state: "unclear", kind: "choice", reason: "insufficient_evidence" });
  if (!result.ok) return;
  expect(result.value.probabilities).toEqual(insufficient.probabilities);
  expect(result.value.confidence).toBe(insufficient.confidence);
  expect(result.value.reproducibility_metadata).toMatchObject({ raw_answer: insufficient });
});

test("a choice with spaces and punctuation is designated even when other options are mentioned", async () => {
  const choice = "not-enough evidence";
  const choices = ["yes", "no", choice];
  const text = JSON.stringify({ system_one: { type: "choice", instructions: "Judge evidence",
    criteria: Object.fromEntries(choices.map((value) => [value, value])) } });
  const runner = createJevDirectRunner({ api_key: "key", base_url: "https://stub.invalid/v1",
    transport: async () => response(provider({ type: "choice", choice,
      probabilities: { yes: 0.1, no: 0.2, [choice]: 0.7 }, confidence: 0.7 })) });
  const result = await runner.run({ ...context, question: { ...context.question, allowed_values: choices,
    unclear_semantics: "Choose not-enough evidence when unclear; choose yes or no only when settled." },
    evaluator: { ...context.evaluator, instruction_text: text, prompt_digest: instructionDigest(text) } });
  expect(result.ok && result.value.answer).toEqual({ state: "unclear", kind: "choice", reason: choice });
});

test("ambiguous or missing unclear designation fails before a provider call", async () => {
  let calls = 0;
  const runner = createJevDirectRunner({ api_key: "key", base_url: "https://stub.invalid/v1",
    transport: async () => { calls++; return response(provider(answer)); } });
  for (const unclear_semantics of ["Choose faithful or changed when uncertain", "Judge the evidence carefully"]) {
    const result = await runner.run({ ...context, question: { ...context.question, unclear_semantics } });
    expect(result).toMatchObject({ ok: false, error: { category: "invalid_unclear_designation" } });
  }
  expect(calls).toBe(0);
});

test("Jev Score keeps fractional level, legend and full level distribution", async () => {
  const score = { type: "score", score: 1.35, legend: { "0": "poor", "1": "partial", "2": "good" },
    probabilities: { "0": 0.05, "1": 0.55, "2": 0.4 }, confidence: 0.73 };
  const runner = createJevDirectRunner({ api_key: "key", base_url: "https://api.typesafe.ai/v1", transport: async () => response(provider(score)) });
  const result = await runner.run({ ...context, question: { ...context.question, response_kind: "structured",
    allowed_values: null, }, evaluator: { ...context.evaluator, instruction_text: JSON.stringify({ system_one: { type: "score", instructions: "Rate", criteria: ["poor", "partial", "good"] } }) } });
  expect(result.ok).toBe(true);
  if (!result.ok || result.value.answer.state !== "answered" || result.value.answer.kind !== "structured") return;
  expect(result.value.answer.value).toMatchObject({ ...score, expected_level: 1.35,
    rubric_level_distribution: [{ level: "0", probability: 0.05 }, { level: "1", probability: 0.55 }, { level: "2", probability: 0.4 }] });
  expect(result.value.probabilities).toEqual(score.probabilities);
  expect(result.value.confidence).toBe(0.73);
});

test("Jev Yes/No records P(true) rather than a boolean pass", async () => {
  const runner = createJevDirectRunner({ api_key: "key", base_url: "https://api.typesafe.ai/v1", transport: async () => response(provider({ type: "noul", noul: 0.37 })) });
  const result = await runner.run({ ...context, question: { ...context.question, response_kind: "numeric",
    allowed_values: null, }, evaluator: { ...context.evaluator, instruction_text: JSON.stringify({ system_one: { type: "noul", instructions: "Is it faithful?" } }) } });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.answer).toEqual({ state: "answered", kind: "numeric", value: 0.37 });
  expect(result.value.probabilities).toEqual({ true: 0.37, false: 0.63 });
  expect(result.value.reproducibility_metadata).toMatchObject({
    probability_provenance: { true: "provider_noul", false: "derived_complement" } });
});

test("Jev retains a provider-returned Yes/No distribution without deriving a complement", async () => {
  const providerAnswer = { type: "noul", noul: 0.37, probabilities: { true: 0.37, false: 0.63 }, confidence: 0.48 };
  const runner = createJevDirectRunner({ api_key: "key", base_url: "https://api.typesafe.ai/v1", transport: async () => response(provider(providerAnswer)) });
  const result = await runner.run({ ...context, question: { ...context.question, response_kind: "numeric",
    allowed_values: null, }, evaluator: { ...context.evaluator, instruction_text: JSON.stringify({ system_one: { type: "noul", instructions: "Is it faithful?" } }) } });
  expect(result.ok && result.value.probabilities).toEqual(providerAnswer.probabilities);
  if (result.ok) expect(result.value.reproducibility_metadata).toMatchObject({ probability_provenance: "provider_returned" });
});

test("transport, status and response validation failures are Result errors", async () => {
  const runners = [
    createJevDirectRunner({ api_key: "key", base_url: "https://api.typesafe.ai/v1", transport: async () => { throw new Error("secret"); } }),
    createJevDirectRunner({ api_key: "key", base_url: "https://api.typesafe.ai/v1", transport: async () => response({}, 503) }),
    createJevDirectRunner({ api_key: "key", base_url: "https://api.typesafe.ai/v1", transport: async () => response(provider({ type: "choice", choice: "faithful" })) }),
  ];
  for (const runner of runners) {
    const result = await runner.run(context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ operation: "jev_direct", entity_id: "jev" });
  }
});

test("provider HTTP failure preserves its request id without storing the response body", async () => {
  const runner = createJevDirectRunner({ api_key: "key", base_url: "https://api.typesafe.ai/v1", transport: async () => new Response("secret response", {
    status: 503, headers: { "x-request-id": "provider-request-1" } }) });
  const result = await runner.run(context);
  expect(result).toMatchObject({ ok: false, error: {
    external_execution_id: "provider-request-1", detail: "provider HTTP 503" } });
  expect(JSON.stringify(result)).not.toContain("secret response");
});
