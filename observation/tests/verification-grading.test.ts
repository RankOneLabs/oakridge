import { expect, test } from "bun:test";
import { parseGraderConfiguration, planRegistration } from "../src/grading/configuration";
import { oakridgeProfile } from "../src/producers/oakridge/profile";
import { EDITED_ESTIMATE_PER_CALL, editedRunChecks, failureChecks, gradingEdit, offRunChecks, pinnedArrivalChecks, settledRun,
  unlinkedAnalysisChecks, waitingCaptureChecks } from "../verification/grading";
import type { MeasurementReadback, SpendReadback } from "../verification/proof-contract";
import { committedGraders } from "./grading-fixture";

const configured = async () => {
  const parsed = parseGraderConfiguration(await committedGraders());
  if (!parsed.ok) throw new Error(parsed.error.detail);
  return parsed.value;
};
const plan = (configuration: Parameters<typeof planRegistration>[0]) => {
  const planned = planRegistration(configuration, oakridgeProfile.questions);
  if (!planned.ok) throw new Error(planned.error.detail);
  return planned.value;
};
const sent = (attempt: number, failure_category: string | null = null, outcome: string | null = "completed") =>
  ({ attempt, request_sent: true, outcome, failure_category, charged_cost: 0.01, provider_request_id: null });
function measurement(fields: Partial<MeasurementReadback>): MeasurementReadback {
  return { checkpoint: "c", run_id: "run-1", occurrence_id: "o1", revision_id: "r1", item_path: "/findings/0", item_kind: "finding",
    question_id: "finding.relevance", question_version: "1", evidence_set_id: "e1", readiness: "ready", is_human_ready: true,
    evaluator_definition_id: "x", model: "m", execution_id: "x1", state: "answered", detail: null, observation_id: "g1", answer: null,
    attempts: [sent(1)], ...fields };
}
const spendOf = (fields: Partial<SpendReadback>): SpendReadback => ({ checkpoint: "c", run_id: "run-1", grading_enabled: true, committed: 0.01,
  requests_sent: 1, attempts: 1, executions: { completed: 1 }, ...fields });
const failed = (checks: readonly { readonly name: string; readonly passed: boolean }[]) => checks.filter((check) => !check.passed).map((check) => check.name);

test("the edit swaps instructions and sets an estimate that fits one request in the default allowance", async () => {
  const committed = await configured();
  const edit = gradingEdit(committed);
  expect(edit.questions.flatMap((entry) => entry.graders.map((grader) => grader.estimated_cost_per_call)).every((cost) => cost === EDITED_ESTIMATE_PER_CALL)).toBe(true);
  expect(EDITED_ESTIMATE_PER_CALL <= 5 && EDITED_ESTIMATE_PER_CALL * 2 > 5).toBe(true);
  const before = new Set(plan(committed).graders.map((grader) => grader.evaluator_definition_id));
  expect(plan(edit).graders.some((grader) => before.has(grader.evaluator_definition_id))).toBe(false);
});

test("a run is settled only when nothing is pending, unadmitted or uncollected", () => {
  expect([settledRun([measurement({})]), settledRun([measurement({ state: "pending", detail: "claimed" })]),
    settledRun([measurement({ state: "awaiting_admission" })]), settledRun([measurement({ state: "not_ready", detail: "collection_pending" })]),
    settledRun([measurement({ state: "not_ready", detail: "repository_unavailable" })]), settledRun([])]).toEqual([true, false, false, false, true, false]);
});

test("the unlinked analysis passes only with real answers from pinned evaluators and no task", async () => {
  const committed = plan(await configured());
  const id = committed.graders[0]!.evaluator_definition_id;
  expect(failed(unlinkedAnalysisChecks([measurement({ evaluator_definition_id: id })], spendOf({}), ["finding", "risk"], committed))).toEqual([]);
  expect(failed(unlinkedAnalysisChecks([measurement({ evaluator_definition_id: id })], spendOf({}), ["finding", "task"], committed)))
    .toEqual(["the run has no task when its analysis is graded"]);
  expect(failed(unlinkedAnalysisChecks([measurement({ evaluator_definition_id: id, attempts: [] })], spendOf({ requests_sent: 0 }), ["finding"], committed)))
    .toContain("every analysis question is answered by the configured provider");
});

test("an off run passes only with human-ready evidence and no request", () => {
  const off = measurement({ state: "grading_off", execution_id: null, observation_id: null, attempts: [] });
  const quiet = spendOf({ grading_enabled: false, requests_sent: 0, attempts: 0, executions: { completed: 0 } });
  expect(failed(offRunChecks([off], quiet))).toEqual([]);
  expect(failed(offRunChecks([off], { ...quiet, requests_sent: 1 }))).toEqual(["it sends no provider request and admits nothing"]);
});

test("waits at capture must be unadmitted, and later answered with their capture-time evaluators", async () => {
  const committed = plan(await configured());
  const edited = plan(gradingEdit(await configured()));
  const original = committed.graders[1]!.evaluator_definition_id;
  const waiting = measurement({ evidence_set_id: "e2", evaluator_definition_id: original, state: "not_ready", detail: "repository_unavailable",
    execution_id: null, observation_id: null, attempts: [] });
  expect(failed(waitingCaptureChecks([measurement({}), waiting]))).toEqual([]);
  expect(failed(pinnedArrivalChecks([waiting], [measurement({ evidence_set_id: "e2", evaluator_definition_id: original })], committed, edited))).toEqual([]);
  expect(failed(pinnedArrivalChecks([waiting], [{ ...waiting, state: "awaiting_admission" }], committed, edited)))
    .toEqual(["every question that waited is answered once its input arrives", "their first answers use the evaluators pinned at capture, not the edit"]);
});

test("a later capture under the edit passes only with new evaluators, one answer and a deferral without a request", async () => {
  const edited = plan(gradingEdit(await configured()));
  const id = edited.graders[0]!.evaluator_definition_id;
  const deferred = measurement({ evidence_set_id: "e2", evaluator_definition_id: id, state: "budget_deferred", observation_id: null, attempts: [] });
  expect(failed(editedRunChecks([measurement({ evaluator_definition_id: id }), deferred], spendOf({ committed: 3 }), edited))).toEqual([]);
  expect(failed(editedRunChecks([measurement({ evaluator_definition_id: id })], spendOf({ committed: 3 }), edited)))
    .toEqual(["what cannot fit is budget_deferred, with no request and no answer"]);
});

test("the failure phase needs a recovered claim, recorded refusals and exhaustion with no grade", () => {
  const exhausted = measurement({ state: "failed", observation_id: null, attempts: [sent(1, "lease_expired", "failed"), sent(2, "http_error", "failed"),
    sent(3, "http_error", "failed"), sent(4, "http_error", "failed")] });
  expect(failed(failureChecks([exhausted], spendOf({ requests_sent: 4, attempts: 4 })))).toEqual([]);
  expect(failed(failureChecks([{ ...exhausted, attempts: exhausted.attempts.slice(1) }], spendOf({ requests_sent: 3, attempts: 3 }))))
    .toEqual(["an expired claim whose request was in flight is reclaimed, its request kept as a retry"]);
});
