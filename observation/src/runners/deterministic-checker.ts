import { canonicalJson } from "../canonical/canonical-json";
import type { GradingContext, RunnerResult } from "../grading/runner";
import type { GradeRunner } from "../ports/grade-runner";

/** A pure equality check over the first pinned evidence content and the question's expected value. */
export function checkDeterministically(context: GradingContext): RunnerResult {
  const expected = context.question.input_recipe.expected;
  const actual = context.evidence.references[0]?.content;
  if (context.question.response_kind !== "boolean" || expected === undefined || actual === undefined)
    return { ok: false, error: { operation: "deterministic_checker", entity_id: context.question.question_id,
      detail: "boolean question requires expected value and first evidence content" } };
  const left = canonicalJson(expected); const right = canonicalJson(actual);
  if (!left.ok || !right.ok) return { ok: false, error: { operation: "deterministic_checker",
    entity_id: context.question.question_id, detail: "evidence or expected value is not canonical JSON" } };
  return { ok: true, value: { answer: { state: "answered", kind: "boolean", value: left.value === right.value },
    rationale: "canonical equality of pinned expected value and first evidence content" } };
}
export const deterministicChecker: GradeRunner = { kind: "code", run: async (context) => checkDeterministically(context) };
