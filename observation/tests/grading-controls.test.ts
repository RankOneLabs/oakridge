import { expect, test } from "bun:test";
import { DEFAULT_RUN_SPEND, estimatedCostPerCall, fitsRunAllowance, gradingControls } from "../src/grading/budget";
import { answerProblem, failureDisposition, measurementState } from "../src/grading/execution";
import { OAKRIDGE_QUESTIONS } from "../src/producers/oakridge/questions";
import type { GradeObservationId } from "../src/domain/identity";

const relevance = OAKRIDGE_QUESTIONS[0]!;

test("the run allowance defaults to five dollars and is the only spend cap", () => {
  expect(DEFAULT_RUN_SPEND).toBe(5);
  expect(gradingControls({})).toEqual({ ok: true, value: { run_spend: 5, retry_limit: 3, provider_deadline_ms: 30_000, lease_ms: 45_000 } });
  // Stage caps and stage concurrency no longer exist: their old names change nothing.
  expect(gradingControls({ OBSERVATION_GRADING_STAGE_SPEND: "0", OBSERVATION_GRADING_STAGE_CONCURRENCY: "0",
    OBSERVATION_GRADING_RUN_CONCURRENCY: "0" })).toEqual(gradingControls({}));
  expect(gradingControls({ OBSERVATION_GRADING_RUN_SPEND: "0.5" })).toMatchObject({ ok: true, value: { run_spend: 0.5 } });
});

test("a malformed control refuses startup rather than falling back", () => {
  for (const env of [{ OBSERVATION_GRADING_RUN_SPEND: "-1" }, { OBSERVATION_GRADING_RUN_SPEND: "" }, { OBSERVATION_GRADING_RETRY_LIMIT: "1.5" },
    { OBSERVATION_GRADING_LEASE_MS: "40000" }, { OBSERVATION_PROVIDER_DEADLINE_MS: "60000", OBSERVATION_GRADING_LEASE_MS: "70000" }])
    expect({ env, ok: gradingControls(env).ok }).toEqual({ env, ok: false });
  expect(gradingControls({ OBSERVATION_PROVIDER_DEADLINE_MS: "60000" })).toMatchObject({ ok: true, value: { lease_ms: 75_000 } });
});

test("the next request fits only within what the run has not yet sent or reserved", () => {
  expect([fitsRunAllowance({ committed: 4.99, estimate: 0.01, allowance: 5 }), fitsRunAllowance({ committed: 4.995, estimate: 0.01, allowance: 5 }),
    fitsRunAllowance({ committed: 0.1 + 0.2, estimate: 0, allowance: 0.3 })]).toEqual([true, false, true]);
});

test("the estimate comes from the pinned definition's cost metadata", () => {
  expect([estimatedCostPerCall({ estimated_cost_per_call: 0.01 }), estimatedCostPerCall(null), estimatedCostPerCall({ estimated_cost_per_call: -1 })])
    .toEqual([0.01, null, null]);
});

test("retryable failures retry while retries remain, then end with a distinct cause", () => {
  expect([failureDisposition("timeout", { retries: 0, retry_limit: 1 }), failureDisposition("timeout", { retries: 1, retry_limit: 1 }),
    failureDisposition("invalid_answer", { retries: 1, retry_limit: 1 }), failureDisposition("unconfigured_credential", { retries: 0, retry_limit: 3 })])
    .toEqual([{ kind: "retry", retries: 1 }, { kind: "fail", terminal_cause: "retry_exhausted" }, { kind: "fail", terminal_cause: "invalid_outcome" },
      { kind: "fail", terminal_cause: "runner_failed" }]);
});

test("answers are checked against the pinned question's allowed values", () => {
  expect([answerProblem(relevance, { state: "answered", kind: "choice", value: "irrelevant" }),
    answerProblem(relevance, { state: "answered", kind: "choice", value: "unclear" })]).toEqual([null, null]);
  expect(answerProblem(relevance, { state: "answered", kind: "choice", value: "maybe" })).toContain("not an allowed value");
  expect(answerProblem(relevance, { state: "answered", kind: "boolean", value: true })).toContain("differs");
});

test("not ready, grading off, pending, deferred, failed and answered stay distinct", () => {
  const ready = { state: "ready", references: [], ready_at: new Date() } as const;
  const run = (execution: Parameters<typeof measurementState>[0]["execution"], is_grading_enabled = true) =>
    measurementState({ readiness: ready, is_grading_enabled, execution, observation: null }).state;
  expect([measurementState({ readiness: { state: "not_ready", reason: { code: "build_result_unavailable", detail: "d" } }, is_grading_enabled: true,
    execution: null, observation: null }).state, run(null, false), run(null), run({ status: "claimed", terminal_cause: null, error: null }),
    run({ status: "budget_deferred", terminal_cause: null, error: null }), run({ status: "failed", terminal_cause: "retry_exhausted", error: "timeout" })])
    .toEqual(["not_ready", "grading_off", "awaiting_admission", "pending", "budget_deferred", "failed"]);
  expect(measurementState({ readiness: ready, is_grading_enabled: true, execution: { status: "completed", terminal_cause: null, error: null },
    observation: { observation_id: "o" as GradeObservationId, answer: { state: "answered", kind: "choice", value: "relevant" } } }).state).toBe("answered");
});
