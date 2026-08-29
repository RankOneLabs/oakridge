import { expect, test } from "bun:test";
import { selectRunRecordUnitDecision, type OperatorRunRecordUnitFacts } from "../src/domain/operator-projections";
import { selectRunStatus, selectStageStatus, selectV2RunStatus, selectV2StageStatus, selectV2UnitStatus } from "../src/operators/select-status";

test("v2 operator status is selected only from persisted run-owned state", () => {
  expect(selectV2RunStatus("active", 0, false)).toBe("pending");
  expect(selectV2RunStatus("active", 0, true)).toBe("running");
  expect(selectV2RunStatus("active", 1, true)).toBe("parked");
  expect(selectV2RunStatus("failed", 1, true)).toBe("failed");
  expect(selectV2StageStatus("active", true)).toBe("parked");
  expect(selectV2StageStatus("succeeded", false)).toBe("complete");
  expect(selectV2UnitStatus("ready", false)).toBe("pending");
  expect(selectV2UnitStatus("waiting", true)).toBe("parked");
});

test("pending gate dominates engine running status for operator projections", () => {
  expect(selectStageStatus("PENDING", true)).toBe("parked");
  expect(selectRunStatus("PENDING", 1)).toBe("parked");
});

test("DBOS terminal states map mechanically into Oakridge vocabulary", () => {
  expect(selectRunStatus("SUCCESS", 0)).toBe("complete");
  expect(selectRunStatus("ERROR", 0)).toBe("failed");
  expect(selectRunStatus("CANCELLED", 0)).toBe("cancelled");
  expect(selectStageStatus("SUCCESS", false)).toBe("complete");
});

test("a workflow that returned a failure is reported failed despite DBOS recording SUCCESS", () => {
  expect(selectRunStatus("SUCCESS", 0, { kind: "failed", code: "required_output_missing", detail: "unit 'web' is missing: plan" })).toBe("failed");
  expect(selectStageStatus("SUCCESS", false, { kind: "failed", code: "exit_unknown", detail: "no exit code" })).toBe("failed");
});

test("a workflow that returned a cancellation is reported cancelled, not complete", () => {
  expect(selectRunStatus("SUCCESS", 0, { kind: "cancelled", reason: "operator request" })).toBe("cancelled");
});

test("a recorded success stays complete", () => {
  expect(selectRunStatus("SUCCESS", 0, { kind: "succeeded" })).toBe("complete");
  expect(selectStageStatus("SUCCESS", false, { kind: "succeeded" })).toBe("complete");
});

test("outcome does not override liveness for a workflow that is still running", () => {
  expect(selectRunStatus("PENDING", 0, null)).toBe("running");
  expect(selectStageStatus("PENDING", false, null)).toBe("running");
});

test("enqueued workflows remain pending at every operator projection level", () => {
  expect(selectRunStatus("ENQUEUED", 0, null)).toBe("pending");
  expect(selectStageStatus("ENQUEUED", false, null)).toBe("pending");
});

test("a pending gate still dominates a recorded failure", () => {
  expect(selectStageStatus("SUCCESS", true, { kind: "failed", code: "gate_rejected", detail: "rejected" })).toBe("parked");
});

/**
 * The v2 run-record projection's unit decision, restated over display-level
 * facts rather than full domain rows — see `selectUnitDecision` in
 * `run-decisions.ts` for the authoritative selector this mirrors. No executor
 * health, workflow return value, or DBOS status has a field to occupy here.
 */
const facts = (overrides: Partial<OperatorRunRecordUnitFacts> = {}): OperatorRunRecordUnitFacts => ({
  unit_state: "working", all_required_released: false, has_open_wait: false, has_available_work_order: false, has_started_work_order: false,
  is_admitted: true, dependencies_satisfied: true, ...overrides,
});

test("a cancelled or failed unit dominates every other fact", () => {
  expect(selectRunRecordUnitDecision(facts({ unit_state: "cancelled", all_required_released: true }))).toBe("cancelled");
  expect(selectRunRecordUnitDecision(facts({ unit_state: "failed", has_open_wait: true }))).toBe("failed");
});

test("every required slot released is satisfied even with a work order still on record", () => {
  expect(selectRunRecordUnitDecision(facts({ all_required_released: true, has_started_work_order: true }))).toBe("satisfied");
});

test("a pending slot's open wait reads as waiting, not needing new work", () => {
  expect(selectRunRecordUnitDecision(facts({ has_open_wait: true }))).toBe("waiting");
});

test("available and started work rank below a wait but above needing new work", () => {
  expect(selectRunRecordUnitDecision(facts({ has_available_work_order: true }))).toBe("work_available");
  expect(selectRunRecordUnitDecision(facts({ has_started_work_order: true }))).toBe("work_in_progress");
});

test("an available order is not actionable before admission and dependencies", () => {
  expect(selectRunRecordUnitDecision(facts({ has_available_work_order: true, is_admitted: false }))).toBe("needs_work");
  expect(selectRunRecordUnitDecision(facts({ has_available_work_order: true, dependencies_satisfied: false }))).toBe("needs_work");
});

test("nothing missing, waiting, or in progress needs an explicit new work order", () => {
  expect(selectRunRecordUnitDecision(facts())).toBe("needs_work");
});
