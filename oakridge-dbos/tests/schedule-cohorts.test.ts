import { expect, test } from "bun:test";
import { selectStartableCohorts, type SchedulableCohort } from "../src/decision/schedule-cohorts";

const cohort = (cohort_key: string, state_status: SchedulableCohort["state_status"], depends_on: readonly string[] = []): SchedulableCohort =>
  ({ cohort_key, state_status, depends_on });

test("starts a dependency chain one cohort at a time", () => {
  expect(selectStartableCohorts([cohort("a", "complete"), cohort("b", "pending", ["a"]), cohort("c", "pending", ["b"])], 3)).toEqual(["b"]);
});

test("starts both ready arms of a diamond in key order", () => {
  expect(selectStartableCohorts([cohort("c", "pending", ["a"]), cohort("a", "complete"), cohort("b", "pending", ["a"]), cohort("d", "pending", ["b", "c"])], 2)).toEqual(["b", "c"]);
});

test("active and blocked cohorts occupy capacity", () => {
  expect(selectStartableCohorts([cohort("a", "active"), cohort("b", "blocked"), cohort("c", "pending")], 2)).toEqual([]);
});

test("failed, cancelled and unknown dependencies leave descendants pending", () => {
  expect(selectStartableCohorts([cohort("a", "failed"), cohort("b", "cancelled"), cohort("c", "pending", ["a"]), cohort("d", "pending", ["b"]), cohort("e", "pending", ["missing"])], 5)).toEqual([]);
});
