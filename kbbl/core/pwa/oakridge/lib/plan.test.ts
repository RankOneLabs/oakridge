import { describe, expect, test } from "vitest";
import { parsePlan, selectOrderedCohorts, type Plan } from "./plan";
import legacyPlan from "./__fixtures__/legacy-plan.json";
import linkedPlan from "./__fixtures__/id-linked-plan.json";

const cohort = (id: string, depends_on: string[] = []) => ({
  id,
  repository_key: "oakridge",
  title: `Cohort ${id}`,
  scope: "One package.",
  depends_on,
  description: "Does the work.",
  files_in_scope: ["src/a.ts"],
  decisions: ["Keep it small."],
  acceptance_criteria: ["Tests pass."],
});

const body = {
  summary: "Two cohorts.",
  cohorts: [cohort("api", ["core"]), cohort("core")],
  dependency_order: ["core", "api"],
  scope: { in_scope: ["The API"], out_of_scope: ["The UI"] },
  acceptance_criteria: ["Ships."],
  risks: [{ description: "Migration locks", mitigation: "Batch it" }],
};

function parsed(value: unknown): Plan {
  const result = parsePlan(value);
  if (!result.ok) throw new Error(`${result.error.field}: ${result.error.detail}`);
  return result.value;
}

describe("parsePlan", () => {
  test("reads a legacy cohort without inventing ids", () => {
    expect(parsed(legacyPlan).cohorts[0]?.decisions).toEqual(["Keep the existing layout."]);
    expect(parsed(legacyPlan).cohorts[0]?.acceptance_criteria).toEqual(["The plan is readable.", "The brief is readable."]);
  });

  test("reads linked decisions and criteria, including empty link lists", () => {
    const linked = parsed(linkedPlan).cohorts[0];
    expect(linked?.decisions[0]).toEqual({ id: "decision-layout", text: "Keep the existing layout." });
    expect(linked?.acceptance_criteria[0]).toEqual({ id: "criterion-plan", text: "The plan is readable.", task_ids: ["task-plan"], decision_ids: ["decision-layout"] });
    expect(linked?.acceptance_criteria[1]).toEqual({ id: "criterion-brief", text: "The brief is readable.", task_ids: [], decision_ids: [] });
  });

  test.each(["decisions", "acceptance_criteria"] as const)("rejects a mixed %s list at the offending entry", (field) => {
    const mixed = { ...linkedPlan, cohorts: [legacyPlan.cohorts[0], { ...linkedPlan.cohorts[0], [field]: [legacyPlan.cohorts[0][field][0], linkedPlan.cohorts[0][field][0]] }] };
    const result = parsePlan(mixed);
    expect(result.ok ? null : result.error).toMatchObject({ operation: "parse_plan", field: `cohorts[1].${field}[1]` });
  });

  test("accepts the registered artifact body", () => {
    expect(parsePlan(body).ok).toBe(true);
  });

  test("reads a bare-string risk as a risk without a mitigation", () => {
    expect(parsed({ ...body, risks: ["Pin drift"] }).risks).toEqual([{ description: "Pin drift", mitigation: null }]);
  });

  test("reads a missing cohort description as null", () => {
    const { description: _, ...withoutDescription } = cohort("core");
    expect(parsed({ ...body, cohorts: [withoutDescription] }).cohorts[0]?.description).toBeNull();
  });

  test("names the field that breaks the contract", () => {
    const result = parsePlan({ ...body, cohorts: [cohort("core"), { ...cohort("api"), files_in_scope: "src" }] });
    expect(result.ok ? null : result.error.field).toBe("cohorts[1].files_in_scope");
  });

  test("rejects a scope that is not split into in and out", () => {
    expect(parsePlan({ ...body, scope: { include: ["core"] } }).ok).toBe(false);
  });
});

describe("selectOrderedCohorts", () => {
  test("follows dependency_order rather than body order", () => {
    expect(selectOrderedCohorts(parsed(body)).map((entry) => entry.id)).toEqual(["core", "api"]);
  });

  test("keeps cohorts the order omits, after the ordered ones", () => {
    expect(selectOrderedCohorts(parsed({ ...body, dependency_order: ["api"] })).map((entry) => entry.id)).toEqual(["api", "core"]);
  });

  test("lists a cohort once when the order repeats it", () => {
    expect(selectOrderedCohorts(parsed({ ...body, dependency_order: ["core", "core", "api"] })).map((entry) => entry.id)).toEqual(["core", "api"]);
  });
});
