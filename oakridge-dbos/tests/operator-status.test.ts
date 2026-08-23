import { expect, test } from "bun:test";
import { selectRunStatus, selectStageStatus } from "../src/operators/select-status";

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
