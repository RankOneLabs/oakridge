import { expect, test } from "bun:test";
import { selectStartableCohorts, validateBriefCollection, validatePlanCohorts, type SchedulableCohort } from "../src/decision/schedule-cohorts";
import type { BuildBriefBody, PlanBody, PlanCohort } from "../src/domain/dev-flow-artifacts";

const cohort = (cohort_key: string, state_status: SchedulableCohort["state_status"], depends_on: readonly string[] = []): SchedulableCohort =>
  ({ cohort_key, state_status, depends_on });

test("starts a dependency chain one cohort at a time", () => {
  expect(selectStartableCohorts([cohort("a", "complete"), cohort("b", "pending", ["a"]), cohort("c", "pending", ["b"])], 3)).toEqual(["b"]);
});

test("starts both ready arms of a diamond in accepted plan order", () => {
  expect(selectStartableCohorts([cohort("c", "pending", ["a"]), cohort("a", "complete"), cohort("b", "pending", ["a"]), cohort("d", "pending", ["b", "c"])], 2)).toEqual(["c", "b"]);
});

const planCohort = (id: string, overrides: Partial<PlanCohort> = {}): PlanCohort => ({
  id, repository_key: "oakridge", title: id, scope: id, depends_on: [], description: null,
  files_in_scope: [], decisions: [], acceptance_criteria: ["passes"], ...overrides,
});
const plan = (cohorts: readonly PlanCohort[]): PlanBody => ({
  summary: "plan", cohorts, scope: { in_scope: [], out_of_scope: [] }, acceptance_criteria: [], risks: [],
});
const brief = (cohort_id: string, overrides: Partial<BuildBriefBody> = {}): BuildBriefBody => ({
  cohort_id, repository_key: "oakridge", title: cohort_id, depends_on: [], goal: "build",
  files_in_scope: [], decisions_made: [], approaches_rejected: [], acceptance_criteria: ["passes"], next_action: "start",
  ...overrides,
});

test("plan readiness reports distinct graph and repository errors", () => {
  const repositories = new Set(["oakridge"]);
  const failures: readonly [PlanBody, string][] = [
    [plan([]), "empty_plan"],
    [plan([planCohort("bad key")]), "invalid_cohort_key"],
    [plan([planCohort("a"), planCohort("a")]), "duplicate_cohort_key"],
    [plan([planCohort("a", { repository_key: "missing" })]), "unknown_repository"],
    [plan([planCohort("a", { depends_on: ["a"] })]), "self_dependency"],
    [plan([planCohort("a", { depends_on: ["missing"] })]), "unknown_dependency"],
    [plan([planCohort("a", { depends_on: ["b"] }), planCohort("b", { depends_on: ["a"] })]), "cyclic_dependency"],
  ];
  for (const [value, kind] of failures) expect(validatePlanCohorts(value, repositories)).toEqual({
    ok: false, error: expect.objectContaining({ operation: "validate_plan_cohorts", kind }),
  });
  expect(validatePlanCohorts(plan([planCohort("a"), planCohort("b", { depends_on: ["a"] })]), repositories).ok).toBe(true);
});

test("brief review rejects a missing, extra, duplicate, or changed collection member as a whole", () => {
  const acceptedPlan = [planCohort("a"), planCohort("b", { depends_on: ["a"] })];
  const failures: readonly [readonly BuildBriefBody[], string][] = [
    [[brief("a")], "missing_member"],
    [[brief("a"), brief("b", { depends_on: ["a"] }), brief("extra")], "unknown_member"],
    [[brief("a"), brief("a")], "duplicate_member"],
    [[brief("a", { repository_key: "other" }), brief("b", { depends_on: ["a"] })], "repository_changed"],
    [[brief("a"), brief("b")], "dependencies_changed"],
    [[brief("a", { acceptance_criteria: ["changed"] }), brief("b", { depends_on: ["a"] })], "acceptance_criteria_changed"],
  ];
  for (const [value, kind] of failures) expect(validateBriefCollection(acceptedPlan, value)).toEqual({
    ok: false, error: expect.objectContaining({ operation: "validate_brief_collection", kind }),
  });
  expect(validateBriefCollection(acceptedPlan, [brief("a"), brief("b", { depends_on: ["a"] })]).ok).toBe(true);
});

test("active and blocked cohorts occupy capacity", () => {
  expect(selectStartableCohorts([cohort("a", "active"), cohort("b", "blocked"), cohort("c", "pending")], 2)).toEqual([]);
});

test("failed, cancelled and unknown dependencies leave descendants pending", () => {
  expect(selectStartableCohorts([cohort("a", "failed"), cohort("b", "cancelled"), cohort("c", "pending", ["a"]), cohort("d", "pending", ["b"]), cohort("e", "pending", ["missing"])], 5)).toEqual([]);
});
