import { expect, test } from "bun:test";
import { LANGFUSE_PILOT_QUESTIONS } from "../src/grading/catalogue/langfuse-pilot";
import { instructionDigest } from "../src/grading/evaluator";
import { createJevDirectRunner } from "../src/runners/jev-direct";
import { registerGradingContext, runGrade } from "../src/storage/grading-store";
import { evidence, evaluator, question, scratchGrading, tenant } from "./grading-fixture";

const unclear = "unclear_insufficient_evidence";
const pilotIds = ["analysis.finding_relevance", "plan.criterion_traceability", "brief.source_fidelity"] as const;

test("each pilot choice maps its designated option to unclear", async () => {
  for (const id of pilotIds) {
    const pilot = LANGFUSE_PILOT_QUESTIONS[id].definition;
    const values = pilot.allowed_values!.map(String);
    const instruction_text = JSON.stringify({ system_one: { type: "choice", instructions: "Judge the evidence",
      criteria: Object.fromEntries(values.map((value) => [value, value])) } });
    const runner = createJevDirectRunner({ api_key: "key", base_url: "https://stub.invalid/v1",
      transport: async () => Response.json({ model: "jev-1.14.0", answers: { [id]: { type: "choice", choice: unclear,
        probabilities: Object.fromEntries(values.map((value) => [value, value === unclear ? 0.8 : 0.1])), confidence: 0.8 } },
        usage: { input_tokens: 10, output_tokens: 2 } }) });
    const result = await runner.run({ question: pilot, evidence, evaluator: { ...evaluator("model"), model: "jev-1.14.0",
      instruction_text, prompt_digest: instructionDigest(instruction_text) } });
    expect(result.ok && result.value.answer).toEqual({ state: "unclear", kind: "choice", reason: unclear });
  }
});

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
integration("inconclusive present evidence and missing evidence occupy separate stored states", async () => scratchGrading(async (db, occurrence_id) => {
  const instruction_text = JSON.stringify({ system_one: { type: "choice", instructions: "Judge",
    criteria: { yes: "Supported", no: "Unsupported", unclear: "Inconclusive" } } });
  const selectedQuestion = { ...question, response_kind: "choice" as const, allowed_values: ["yes", "no", "unclear"],
    missing_evidence_policy: "abstain" as const, unclear_semantics: "Choose unclear when evidence is inconclusive" };
  const selectedEvaluator = { ...evaluator("model"), evaluator_definition_id: "state-test", model: "jev-1.14.0",
    instruction_text, prompt_digest: instructionDigest(instruction_text) };
  const missingEvidence = { ...evidence, evidence_set_id: "missing-state-test" as typeof evidence.evidence_set_id,
    is_incomplete: true, incompleteness_reason: "requested source was not captured" };
  for (const selectedEvidence of [evidence, missingEvidence]) {
    const registration = await registerGradingContext(db, tenant, { question: selectedQuestion, evidence: selectedEvidence,
      evaluator: selectedEvaluator });
    expect(registration.ok).toBe(true);
  }
  let calls = 0;
  const runner = createJevDirectRunner({ api_key: "key", base_url: "https://stub.invalid/v1", transport: async () => {
    calls++;
    return Response.json({ model: "jev-1.14.0", answers: { relevance: { type: "choice", choice: "unclear",
      probabilities: { yes: 0.1, no: 0.1, unclear: 0.8 }, confidence: 0.8 } },
      usage: { input_tokens: 10, output_tokens: 2 } });
  } });
  const identity = { subject_occurrence_id: occurrence_id, question_id: selectedQuestion.question_id,
    question_version: selectedQuestion.question_version, evaluator_definition_id: selectedEvaluator.evaluator_definition_id,
    config_digest: selectedEvaluator.config_digest };
  const inconclusive = await runGrade(db, tenant, { identity: { ...identity, evidence_set_id: evidence.evidence_set_id,
    attempt_label: "inconclusive" }, runner });
  const missing = await runGrade(db, tenant, { identity: { ...identity, evidence_set_id: missingEvidence.evidence_set_id,
    attempt_label: "missing" }, runner });
  expect(inconclusive.ok && inconclusive.value.observation?.answer_state).toBe("unclear");
  expect(missing.ok && missing.value.observation?.answer_state).toBe("abstain");
  expect(calls).toBe(1);
}));
