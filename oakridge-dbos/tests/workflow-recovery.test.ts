/**
 * A PENDING workflow row is not proof of a live workflow. DBOS recovers one
 * only when its application_version matches the executor's, so a version bump
 * between restarts strands every in-flight run: PENDING forever, never
 * recovered, never terminalized. Anything that waits on such a row waits
 * forever, which is how one orphan made a session unclosable and cancellation
 * hang.
 */
import { expect, test } from "bun:test";

import type { OperatorApplicationVersionInventory } from "../src/domain/operator-projections";
import { selectOrphanedVersionRuns, selectWorkflowRecovery } from "../src/domain/workflow-recovery";

test("a workflow started under this executor's version is recoverable", () => {
  expect(selectWorkflowRecovery("v2", "v2")).toEqual({ kind: "recoverable" });
});

test("a workflow left behind by another version is abandoned", () => {
  expect(selectWorkflowRecovery("v1", "v2")).toEqual({ kind: "abandoned", holder_application_version: "v1" });
});

/**
 * Rows written before workflows carried a version are not evidence of
 * abandonment, so they keep the benefit of the doubt rather than being
 * terminalized on a guess.
 */
test("a workflow with no recorded version is recoverable", () => {
  expect(selectWorkflowRecovery(null, "v2")).toEqual({ kind: "recoverable" });
});

/**
 * The two mistakes are not symmetric. Containment now *cancels* what it judges
 * abandoned, so a false abandonment destroys a gate somebody is still waiting
 * on, while a false liveness only reproduces the old stall. With nothing
 * meaningful to compare against, nothing is condemned.
 */
test("an unset executor version condemns nothing", () => {
  expect(selectWorkflowRecovery("v1", "")).toEqual({ kind: "recoverable" });
});

const inventory = (
  overrides: Partial<OperatorApplicationVersionInventory>,
): OperatorApplicationVersionInventory => ({
  application_version: "v1", run_count: 3, pending_run_count: 1, gated_run_count: 0,
  oldest_pending_at: "2026-08-19T08:30:00.000Z", ...overrides,
});

test("an older version still owed pending runs is reported", () => {
  expect(selectOrphanedVersionRuns([inventory({})], "v2")).toEqual([{
    application_version: "v1", pending_run_count: 1, gated_run_count: 0,
    oldest_pending_at: "2026-08-19T08:30:00.000Z",
  }]);
});

/**
 * Old versions pile up as ordinary consequence of the code moving. Only the
 * ones still owed work are a problem, and a report that cried about every past
 * commit would be ignored by the second week.
 */
test("an older version whose runs all finished is not reported", () => {
  expect(selectOrphanedVersionRuns([inventory({ pending_run_count: 0 })], "v2")).toEqual([]);
});

test("this executor's own pending runs are not reported as orphaned", () => {
  expect(selectOrphanedVersionRuns([inventory({ application_version: "v2" })], "v2")).toEqual([]);
});

test("pending runs with no recorded version are not reported as orphaned", () => {
  expect(selectOrphanedVersionRuns([inventory({ application_version: null })], "v2")).toEqual([]);
});

/** The count an operator most wants in the first line: gates nobody can clear. */
test("the report carries how many orphaned runs hold an open gate", () => {
  const [orphaned] = selectOrphanedVersionRuns([inventory({ pending_run_count: 7, gated_run_count: 2 })], "v2");
  expect(orphaned?.gated_run_count).toBe(2);
});
