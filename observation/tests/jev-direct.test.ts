import { expect, test } from "bun:test";
import { createJevDirectRunner, createSystemOneRunner } from "../src/runners/jev-direct";
import type { GradingContext } from "../src/grading/runner";
import { evaluatorIdentity, instructionDigest } from "../src/grading/evaluator";
import { OAKRIDGE_QUESTIONS } from "../src/producers/oakridge/questions";
import { withTenant } from "../src/storage/database";
import { registerEvaluator } from "../src/storage/grading-store";
import { evidence, evaluator, integration, question, scratchDatabase, tenant } from "./grading-fixture";

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

test("a producer question reaches the provider using evaluator instructions", async () => {
  const relevance = OAKRIDGE_QUESTIONS[0]!;
  const criteria = Object.fromEntries((relevance.allowed_values ?? []).map((value) => [String(value), String(value)]));
  const text = JSON.stringify({ system_one: { type: "choice", instructions: "Judge relevance", criteria } });
  let was_sent = false;
  const runner = createJevDirectRunner({ api_key: "key", base_url: "https://stub.invalid/v1", transport: async (url, init) => {
    was_sent = true;
    expect(url).toBe("https://stub.invalid/v1/systemone");
    expect(JSON.parse(String(init.body)).questions[relevance.question_id].instructions).toBe("Judge relevance");
    return response({ model: "jev-1.14.0", answers: { [relevance.question_id]: { type: "choice", choice: "relevant",
      probabilities: { relevant: 0.8, irrelevant: 0.1, unclear: 0.1 }, confidence: 0.8 } },
      usage: { input_tokens: 31, output_tokens: 7 }, cost: 0.01, id: "request-1" });
  } });
  const result = await runner.run({ ...context, question: relevance, evaluator: { ...context.evaluator,
    instruction_text: text, prompt_digest: instructionDigest(text) } });
  expect(was_sent).toBe(true);
  expect(result).toMatchObject({ ok: true, value: { cost: 0.01, external_execution_id: "request-1",
    model_usage: { input_tokens: 31, output_tokens: 7 }, reproducibility_metadata: { provider_model: "jev-1.14.0" } } });
});

test("each producer question designates its own unclear choice", async () => {
  const { unclearChoice } = await import("../src/runners/jev-direct");
  for (const question of OAKRIDGE_QUESTIONS) expect(unclearChoice({ ...context, question })).toBe("unclear");
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

integration("changing stored instructions creates a new evaluator row and identity", async () => scratchDatabase(async (db) => {
  const first = context.evaluator;
  const secondText = JSON.stringify({ ...recipe, state_fields: { policy: "revised" } });
  const second = { ...first, evaluator_definition_id: "jev-revised", instruction_text: secondText,
    prompt_digest: instructionDigest(secondText) };
  const firstDigest = evaluatorIdentity(first);
  const secondDigest = evaluatorIdentity(second);
  expect(firstDigest.ok && secondDigest.ok && firstDigest.value !== secondDigest.value).toBe(true);
  for (const selectedEvaluator of [first, second]) {
    expect((await registerEvaluator(db, tenant, selectedEvaluator)).ok).toBe(true);
  }
  const rows = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluator_definition")
    .select(["evaluator_definition_id", "instruction_text", "identity_digest"])
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace).execute());
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.instruction_text).sort()).toEqual([first.instruction_text, secondText].sort());
  expect(new Set(rows.map((row) => row.identity_digest)).size).toBe(2);
}));

test("Jev Choice retains every raw option probability and provider confidence", async () => {
  const runner = createJevDirectRunner({ api_key: "key", base_url: "https://api.typesafe.ai/v1", transport: async (_url, init) => {
    const request = JSON.parse(String(init.body));
    expect(request.state.fixture).toEqual({ source: "reported", reported_by: "agent", revision_id: "revision-1", item_path: "/findings/0", content: "sample" });
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

test("Jev records the question-designated unclear choice as an answer", async () => {
  const insufficient = { ...answer, choice: "insufficient_evidence" };
  const runner = createJevDirectRunner({ api_key: "key", base_url: "https://api.typesafe.ai/v1", transport: async () => response(provider(insufficient)) });
  const result = await runner.run(context);
  expect(result.ok && result.value.answer).toEqual({ state: "answered", kind: "choice", value: "insufficient_evidence" });
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
  expect(result.ok && result.value.answer).toEqual({ state: "answered", kind: "choice", value: choice });
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
