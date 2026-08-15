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
