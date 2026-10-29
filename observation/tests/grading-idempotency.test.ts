import { expect, test } from "bun:test";
import { evaluationDigest } from "../src/grading/execution";
import { registerGradingContext, runGrade, listGrades } from "../src/storage/grading-store";
import { deterministicChecker } from "../src/runners/deterministic-checker";
import { tenant, question, evidence, evaluator, scratchGrading } from "./grading-fixture";

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL || process.env.CI === "true" ? test : test.skip;

test("evaluation digest is canonical over the seven identity fields including attempt label", () => {
  const identity = { subject_occurrence_id: "subject", evidence_set_id: "evidence", question_id: "question",
    question_version: "1", evaluator_definition_id: "code", config_digest: "config", attempt_label: "sample-1" };
  const first = evaluationDigest(identity as Parameters<typeof evaluationDigest>[0]);
  const reorder = evaluationDigest({ ...identity } as Parameters<typeof evaluationDigest>[0]);
  const repeated = evaluationDigest({ ...identity, attempt_label: "sample-2" } as Parameters<typeof evaluationDigest>[0]);
  expect(first).toEqual(reorder);
  expect(first).not.toEqual(repeated);
});

integration("identical retry returns one execution and a new attempt creates another observation", async () => scratchGrading(async (db, occurrence_id) => {
  const context = { question: { ...question, input_recipe: { expected: "sample" } }, evidence, evaluator: evaluator("code") };
  expect((await registerGradingContext(db, tenant, context)).ok).toBe(true);
  const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
    question_id: question.question_id, question_version: question.question_version,
    evaluator_definition_id: "code", config_digest: "config-1", attempt_label: "sample-1" };
  const first = await runGrade(db, tenant, { identity, runner: deterministicChecker });
  const retry = await runGrade(db, tenant, { identity, runner: deterministicChecker });
  const second = await runGrade(db, tenant, { identity: { ...identity, attempt_label: "sample-2" }, runner: deterministicChecker });
  expect(first.ok && retry.ok && second.ok).toBe(true);
  if (!first.ok || !retry.ok || !second.ok) throw new Error("evaluation failed");
  expect(retry.value.was_replay).toBe(true);
  expect(retry.value.execution.execution_id).toBe(first.value.execution.execution_id);
  expect(second.value.execution.execution_id).not.toBe(first.value.execution.execution_id);
  expect(second.value.execution.attempt_label).toBe("sample-2");
  const grades = await listGrades(db, tenant, occurrence_id, { limit: 10, offset: 0 });
  expect(grades?.total).toBe(2);
  expect(new Set(grades?.items.map((item) => item.execution.attempt_label))).toEqual(new Set(["sample-1", "sample-2"]));
}));

integration("concurrent identical requests resolve to one stored execution", async () => scratchGrading(async (db, occurrence_id) => {
  const context = { question: { ...question, input_recipe: { expected: "sample" } }, evidence, evaluator: evaluator("code") };
  expect((await registerGradingContext(db, tenant, context)).ok).toBe(true);
  const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
    question_id: question.question_id, question_version: question.question_version,
    evaluator_definition_id: "code", config_digest: "config-1", attempt_label: "parallel" };
  const [left, right] = await Promise.all([
    runGrade(db, tenant, { identity, runner: deterministicChecker }),
    runGrade(db, tenant, { identity, runner: deterministicChecker }),
  ]);
  expect(left.ok && right.ok).toBe(true);
  if (!left.ok || !right.ok) throw new Error("evaluation failed");
  expect(left.value.execution.execution_id).toBe(right.value.execution.execution_id);
  expect((await listGrades(db, tenant, occurrence_id, { limit: 10, offset: 0 }))?.total).toBe(1);
}));
