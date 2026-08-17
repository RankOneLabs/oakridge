/**
 * When one stage fails, the run ends — but its siblings are still running
 * delegated sessions that nothing downstream will ever consume. These pin which
 * coordinators get contained and what the operator is told about why.
 */
import { expect, test } from "bun:test";

import { selectOrphanedStageCoordinators, stageFailureReason } from "../src/workflows/production-topology";

const started = { build: "root:stage:build", assessor: "root:stage:assessor", planner: "root:stage:planner" };

test("the stage whose failure ended the run keeps its own record", () => {
  expect(selectOrphanedStageCoordinators(started, new Set(["build", "planner"]))).toEqual(["root:stage:assessor"]);
});

test("every sibling still running is contained, not just the first", () => {
  expect(selectOrphanedStageCoordinators(started, new Set(["planner"]))).toEqual(["root:stage:build", "root:stage:assessor"]);
});

test("a run whose stages have all reported has nothing left to contain", () => {
  expect(selectOrphanedStageCoordinators(started, new Set(["build", "assessor", "planner"]))).toEqual([]);
});

test("a stage that never started is not an orphan — it has no coordinator to cancel", () => {
  expect(selectOrphanedStageCoordinators({ planner: "root:stage:planner" }, new Set(["planner"]))).toEqual([]);
});

test("the containment reason names the stage and why it ended", () => {
  expect(stageFailureReason("build", { kind: "failed", code: "required_output_missing", detail: "unit 'web' is missing: plan" }))
    .toBe("stage 'build' failed: required_output_missing");
  expect(stageFailureReason("build", { kind: "cancelled", reason: "operator stopped it" }))
    .toBe("stage 'build' was cancelled: operator stopped it");
  expect(stageFailureReason("build", { kind: "cancelled", reason: null })).toBe("stage 'build' was cancelled");
});
