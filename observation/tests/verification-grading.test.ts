import { describe, expect, test } from "bun:test";
import { machineGraders, parseGradingDefinitions, planRegistration } from "../src/grading/configuration";
import { oakridgeGradingRegistry, committedDefinitions } from "./grading-fixture";
import { CONCURRENT_ESTIMATE_PER_CALL, concurrencyEdit, EDITED_ESTIMATE_PER_CALL, editedRunChecks, failureChecks, gradingEdit, launchConfigCheck,
  offRunChecks, pinnedArrivalChecks, pinReadbackChecks, secondWorkerChecks, settledRun, unlinkedAnalysisChecks,
  waitingCaptureChecks } from "../verification/grading";
import type { FrozenEvidenceReadback, MeasurementReadback, PinReadback, SecondWorkerReadback, SpendReadback,
  StaleSettlementReadback } from "../verification/proof-contract";

const configured = async () => {
  const parsed = parseGradingDefinitions(await committedDefinitions(), oakridgeGradingRegistry);
  if (!parsed.ok) throw new Error(parsed.error.detail);
  return parsed.value;
};
const plan = (configuration: Parameters<typeof planRegistration>[0]) => {
  const planned = planRegistration(configuration, oakridgeGradingRegistry);
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
const spendOf = (fields: Partial<SpendReadback>): SpendReadback => ({ checkpoint: "c", run_id: "run-1", grading_enabled: true, captured_config: null, committed: 0.01,
  requests_sent: 1, attempts: 1, executions: { completed: 1 }, ...fields });
const failed = (checks: readonly { readonly name: string; readonly passed: boolean }[]) => checks.filter((check) => !check.passed).map((check) => check.name);

test("the edit swaps instructions and sets an estimate that fits one request in the default allowance", async () => {
  const committed = await configured();
  const edit = gradingEdit(committed);
  expect(edit.flatMap((entry) => machineGraders(entry).map((grader) => grader.estimated_cost_per_call)).every((cost) => cost === EDITED_ESTIMATE_PER_CALL)).toBe(true);
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

test("the concurrency edit keeps the instructions and lets exactly two requests of a run fit the default allowance", async () => {
  const committed = await configured();
  const edit = concurrencyEdit(committed);
  expect(edit.flatMap((entry) => machineGraders(entry).map((grader) => grader.estimated_cost_per_call))
    .every((cost) => cost === CONCURRENT_ESTIMATE_PER_CALL)).toBe(true);
  expect(CONCURRENT_ESTIMATE_PER_CALL * 2 <= 5 && CONCURRENT_ESTIMATE_PER_CALL * 3 > 5).toBe(true);
  const before = new Set(plan(committed).graders.map((grader) => grader.evaluator_definition_id));
  expect(plan(edit).graders.some((grader) => before.has(grader.evaluator_definition_id))).toBe(false);
});

test("the captured launch config must be exactly the committed one, with the run's grading choice", () => {
  const sessions = { analysis: { author: { model: "m" } } };
  const read = (captured: unknown, authority: unknown) => ({ checkpoint: "c", run_id: "run-1", captured_config: captured, authority_config: authority });
  expect(launchConfigCheck(read({ sessions, grading_enabled: true }, { grading_enabled: true, sessions }), true, "on").passed).toBe(true);
  // A committed config without a grading choice has grading off.
  expect(launchConfigCheck(read({ sessions: {}, grading_enabled: false }, {}), false, "off").passed).toBe(true);
  expect(launchConfigCheck(read({ sessions, grading_enabled: true }, { sessions, grading_enabled: false }), true, "on").passed).toBe(false);
  expect(launchConfigCheck(read({ sessions: {}, grading_enabled: true }, { sessions, grading_enabled: true }), true, "on").passed).toBe(false);
  expect(launchConfigCheck(read(null, { sessions, grading_enabled: true }), true, "on").passed).toBe(false);
});

test("a checkpoint fails when a measurement has no pin or a ready question has no frozen references", () => {
  const pin = (fields: Partial<PinReadback>): PinReadback => ({ checkpoint: "c", run_id: "run-1", occurrence_id: "o1", revision_id: "r1",
    item_path: "/findings/0", item_kind: "finding", question_id: "finding.relevance", question_version: "1", evidence_set_id: "e1",
    pinned_evaluator_definition_ids: ["x", "human"], readiness: "ready", not_ready_code: null, ready_at: "t", references: [{ ref: "subject",
      source: "revision", revision_id: "r1", item_path: "/findings/0", run_id: null, input_path: null, repository_key: null, commit_sha: null,
      path: null, line_range: null, is_absent: null, reported_by: null }], ...fields });
  const frozen: FrozenEvidenceReadback = { checkpoint: "c", run_id: "run-1", occurrence_id: "o1", item_path: "/findings/0",
    question_id: "finding.relevance", evidence_set_id: "e1", ready_at: "t", references: [{ ref: "subject" }] };
  expect(failed(pinReadbackChecks("c", [measurement({})], [pin({})], [frozen]))).toEqual([]);
  expect(failed(pinReadbackChecks("c", [measurement({ evaluator_definition_id: "y" })], [pin({})], [frozen])))
    .toEqual(["every measurement at c reads back its question and evaluator pins"]);
  expect(failed(pinReadbackChecks("c", [measurement({})], [pin({})], [])))
    .toEqual(["every ready question at c reads back its frozen evidence references"]);
  expect(failed(pinReadbackChecks("c", [], [], []))).toHaveLength(2);
});

describe("the second worker's readback", () => {
  const spend = (committed: number, requests_sent: number): SpendReadback => spendOf({ committed, requests_sent });
  const refused = (kind: StaleSettlementReadback["case"], lease_owner: string, claim_attempt: number): StaleSettlementReadback => ({ case: kind,
    execution_id: kind === "killed_service" ? "x1" : "x2", lease_owner, claim_attempt, mark_request_sent: false, complete: "stale_claim", fail: "stale_claim" });
  const passing: SecondWorkerReadback = { run_id: "run-1", run_spend: 5, estimate_per_call: 2, before: spend(2, 1),
    simultaneous: [{ worker: "w0", kind: "claimed", execution_id: "x2", claim_attempt: 1 }, { worker: "w1", kind: "budget_deferred", execution_id: "x3", claim_attempt: null },
      { worker: "w2", kind: "idle", execution_id: null, claim_attempt: null }],
    after_claims: spend(4, 1),
    reclaims: [{ worker: "r", kind: "budget_deferred", execution_id: "x1", claim_attempt: null }, { worker: "r", kind: "claimed", execution_id: "x2", claim_attempt: 2 }],
    stale: [refused("earlier_owner", "w0", 1), refused("older_attempt", "r", 1), refused("killed_service", "service", 1)],
    settlement: { kind: "completed", observation_id: "g1", detail: null }, after: spend(4, 2) };

  test("passes only when exactly what fits is claimed, every stale claim is refused and the reclaim is settled for real", () => {
    expect(failed(secondWorkerChecks(passing))).toEqual([]);
  });
  test("a claim beyond the allowance fails the edge and the reservation checks", () => {
    expect(failed(secondWorkerChecks({ ...passing, simultaneous: [passing.simultaneous[0]!, { worker: "w1", kind: "claimed", execution_id: "x3", claim_attempt: 1 }],
      after_claims: spend(6, 1) }))).toEqual(["simultaneous claims at the run allowance's edge: only what fits is claimed and the rest are budget_deferred",
      "the claims reserve exactly their estimates and never pass the allowance"]);
  });
  test("a stale write that lands fails its case", () => {
    expect(failed(secondWorkerChecks({ ...passing, stale: [{ ...refused("earlier_owner", "w0", 1), complete: "completed" }, ...passing.stale.slice(1)] })))
      .toEqual(["the earlier owner's claim cannot send, complete or fail after the reclaim"]);
    expect(failed(secondWorkerChecks({ ...passing, stale: passing.stale.slice(0, 2) })))
      .toEqual(["the killed service's claim is refused after its lease expired and the execution was reclaimed"]);
  });
  test("a second charge for one request fails the accounting check", () => {
    expect(failed(secondWorkerChecks({ ...passing, after: spend(6, 2) })))
      .toEqual(["each real request is counted once: the expired unsent reservation is released and the reclaim charged once"]);
  });
});
