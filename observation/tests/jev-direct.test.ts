import { expect, test } from "bun:test";
import { createJevDirectRunner, createSystemOneRunner } from "../src/runners/jev-direct";
import { listGrades, readExecution, registerGradingContext, runGrade } from "../src/storage/grading-store";
import type { GradingContext } from "../src/grading/runner";
import { evaluatorIdentity, instructionDigest } from "../src/grading/evaluator";
import { withTenant } from "../src/storage/database";
import { LANGFUSE_PILOT_QUESTIONS } from "../src/grading/catalogue/langfuse-pilot";
import { PILOT_EVIDENCE_RECIPES, pinnedInputRecipe } from "../src/grading/evidence-packages/pilot-recipe";
import { evidence, evaluator, question, scratchGrading, tenant } from "./grading-fixture";

const recipe = { system_one: { type: "choice", instructions: "Classify evidence", criteria: {
  faithful: "Meaning preserved", changed: "Meaning changed", insufficient_evidence: "Not enough evidence" } } };
const context: GradingContext = { question: { ...question, response_kind: "choice",
  allowed_values: ["faithful", "changed", "insufficient_evidence"], unclear_semantics: "Choose insufficient_evidence when unclear", input_recipe: { source: "selected_value" } },
  evidence, evaluator: { ...evaluator("model"), evaluator_definition_id: "jev", provider: "typesafe",
    model: "jev-1.13.0", instruction_text: JSON.stringify(recipe), prompt_digest: instructionDigest(JSON.stringify(recipe)) } };
const answer = { type: "choice", choice: "faithful", probabilities: {
  faithful: 0.62, changed: 0.22, insufficient_evidence: 0.16 }, confidence: 0.41 };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const provider = (value: unknown) => ({ model: "jev-1.13.0", answers: { [question.question_id]: value },
  usage: { input_tokens: 31, output_tokens: 7 } });
const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;

test("System One transport receives a required abort deadline", async () => {
  const runner = createSystemOneRunner({ operation: "deadline-test", base_url: "https://example.invalid",
    api_key: "key", deadline_ms: 10, transport: async (_url, init) => new Promise<Response>((_resolve, reject) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }) });
  const result = await runner.run(context);
  expect(result).toMatchObject({ ok: false, error: { category: "timeout" } });
});

test("a pinned pilot recipe reaches the provider using evaluator instructions", async () => {
  const pilot = LANGFUSE_PILOT_QUESTIONS["plan.criterion_traceability"].definition;
  const criteria = Object.fromEntries((pilot.allowed_values ?? []).map((value) => [String(value), String(value)]));
  const text = JSON.stringify({ system_one: { type: "choice", instructions: "Judge traceability", criteria } });
  let was_sent = false;
  const runner = createJevDirectRunner({ api_key: "key", base_url: "https://stub.invalid/v1", transport: async (url, init) => {
    was_sent = true;
    expect(url).toBe("https://stub.invalid/v1/systemone");
    expect(JSON.parse(String(init.body)).questions[pilot.question_id].instructions).toBe("Judge traceability");
    return response({ model: "jev-1.14.0", answers: { [pilot.question_id]: { type: "choice", choice: "traceable",
      probabilities: { traceable: 0.8, unsupported: 0.1, unclear_insufficient_evidence: 0.1 }, confidence: 0.8 } },
      usage: { input_tokens: 31, output_tokens: 7 }, cost: 0.01, id: "request-1" });
  } });
  const result = await runner.run({ ...context, question: pilot, evaluator: { ...context.evaluator,
    instruction_text: text, prompt_digest: instructionDigest(text) } });
  expect(was_sent).toBe(true);
  expect(result).toMatchObject({ ok: true, value: { cost: 0.01, external_execution_id: "request-1",
    model_usage: { input_tokens: 31, output_tokens: 7 }, reproducibility_metadata: { provider_model: "jev-1.14.0" } } });
});

test("all four pilot input recipes retain their pinned bytes", () => {
  const expected: Record<string, string> = {
    "analysis.finding_relevance": '{"recipe_id":"analysis.finding_relevance","recipe_version":"v1","input_roles":["requested_change","relevant_excerpt"],"output_roles":["analysis_finding"],"projected_fields":["ref","digest","deep_link"]}',
    "plan.criterion_traceability": '{"recipe_id":"plan.criterion_traceability","recipe_version":"v1","input_roles":["plan_task","plan_decision"],"output_roles":["plan_criterion"],"projected_fields":["ref","digest","deep_link"]}',
    "brief.source_fidelity": '{"recipe_id":"brief.source_fidelity","recipe_version":"v1","input_roles":["plan_criterion"],"output_roles":["brief_criterion"],"projected_fields":["ref","digest","deep_link"]}',
    "assessment.coverage": '{"recipe_id":"assessment.coverage","recipe_version":"v1","input_roles":["brief_criterion"],"output_roles":["assessment_finding"],"projected_fields":["ref","digest","deep_link"]}',
  };
  for (const [id, pilot] of Object.entries(LANGFUSE_PILOT_QUESTIONS)) {
    expect(JSON.stringify(pilot.definition.input_recipe)).toBe(expected[id]);
    expect(pilot.definition.input_recipe).toEqual(pinnedInputRecipe(PILOT_EVIDENCE_RECIPES[id as keyof typeof PILOT_EVIDENCE_RECIPES]));
  }
});

test("five provider failures retain distinct categories", async () => {
  const cases = [
    { category: "invalid_choice", api_key: "key", transport: async () => response(provider({ ...answer, choice: "unknown" })) },
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

test("provider modules do not read environment at import", async () => {
  for (const path of ["src/runners/jev-direct.ts", "src/runners/fastino-glide.ts"]) {
    const source = await Bun.file(new URL(`../${path}`, import.meta.url)).text();
    expect(source).not.toContain("process.env");
  }
});

integration("changing stored instructions creates a new evaluator row and identity", async () => scratchGrading(async (db) => {
  const first = context.evaluator;
  const secondText = JSON.stringify({ ...recipe, state_fields: { policy: "revised" } });
  const second = { ...first, evaluator_definition_id: "jev-revised", instruction_text: secondText,
    prompt_digest: instructionDigest(secondText) };
  const firstDigest = evaluatorIdentity(first);
  const secondDigest = evaluatorIdentity(second);
  expect(firstDigest.ok && secondDigest.ok && firstDigest.value !== secondDigest.value).toBe(true);
  for (const selectedEvaluator of [first, second]) {
    expect((await registerGradingContext(db, tenant, { ...context, evaluator: selectedEvaluator })).ok).toBe(true);
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

integration("stored model grade has no normalized score and a failed call creates only a readable execution", async () => scratchGrading(async (db, occurrence_id) => {
  const registered = await registerGradingContext(db, tenant, context);
  expect(registered.ok).toBe(true);
  const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
    question_id: context.question.question_id, question_version: context.question.question_version,
    evaluator_definition_id: "jev", config_digest: context.evaluator.config_digest, attempt_label: "success" };
  const passed = await runGrade(db, tenant, { identity, runner: createJevDirectRunner({ api_key: "key", base_url: "https://api.typesafe.ai/v1", transport: async () => response(provider(answer)) }) });
  expect(passed.ok).toBe(true);
  if (!passed.ok) return;
  expect(passed.value.observation?.answer_payload).toEqual({ state: "answered", kind: "choice", value: "faithful" });
  expect(passed.value.observation?.probabilities).toEqual(answer.probabilities);
  expect(passed.value.observation?.confidence).toBe(answer.confidence);
  expect([passed.value.observation?.normalized_score, passed.value.observation?.decision_policy_id,
    passed.value.observation?.decision_policy_version]).toEqual([null, null, null]);
  const failed = await runGrade(db, tenant, { identity: { ...identity, attempt_label: "failure" },
    runner: createJevDirectRunner({ api_key: "key", base_url: "https://api.typesafe.ai/v1", transport: async () => response({}, 503) }) });
  expect(failed.ok).toBe(true);
  if (!failed.ok) return;
  expect(failed.value.execution.status).toBe("failed");
  expect(failed.value.execution.error).not.toBeNull();
  expect(failed.value.execution.ended_at).not.toBeNull();
  expect(failed.value.observation).toBeNull();
  expect((await readExecution(db, tenant, failed.value.execution.execution_id))?.status).toBe("failed");
  expect((await listGrades(db, tenant, occurrence_id, { limit: 10, offset: 0 }))?.total).toBe(1);
}));

integration("invalid provider outcomes create failed executions without grade rows", async () => scratchGrading(async (db, occurrence_id) => {
  expect((await registerGradingContext(db, tenant, context)).ok).toBe(true);
  const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
    question_id: context.question.question_id, question_version: context.question.question_version,
    evaluator_definition_id: context.evaluator.evaluator_definition_id, config_digest: context.evaluator.config_digest };
  const cases = [
    { label: "invalid-choice", key: "key", transport: async () => response(provider({ ...answer, choice: "outside" })) },
    { label: "invalid-response", key: "key", transport: async () => response({ model: "jev", answers: {} }) },
    { label: "rate-limit", key: "key", transport: async () => response({}, 429) },
    { label: "timeout", key: "key", transport: async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }) },
    { label: "no-key", key: undefined, transport: async () => { throw new Error("must not send"); } },
  ];
  for (const entry of cases) {
    const result = await runGrade(db, tenant, { identity: { ...identity, attempt_label: entry.label },
      runner: createJevDirectRunner({ api_key: entry.key, base_url: "https://stub.invalid/v1",
        transport: entry.transport, deadline_ms: 5 }) });
    expect(result.ok && result.value.execution.status).toBe("failed");
    expect(result.ok && result.value.observation).toBeNull();
  }
}));
