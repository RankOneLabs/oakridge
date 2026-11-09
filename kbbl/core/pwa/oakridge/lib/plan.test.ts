import { describe, expect, test } from "vitest";
import { parsePlan, selectOrderedCohorts, type Plan } from "./plan";
import linkedPlan from "./__fixtures__/id-linked-plan.json";

const decision = { id: "keep-small", text: "Keep it small." };
const criterion = { id: "tests-pass", text: "Tests pass.", decision_ids: ["keep-small"] };

const cohort = (id: string, depends_on: string[] = []) => ({
  id,
  repository_key: "oakridge",
  title: `Cohort ${id}`,
  scope: "One package.",
  depends_on,
  description: "Does the work.",
  files_in_scope: ["src/a.ts"],
  decisions: [decision],
  acceptance_criteria: [criterion],
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
  test("reads linked decisions and criteria, including empty link lists", () => {
    const linked = parsed(linkedPlan).cohorts[0];
    expect(linked?.decisions[0]).toEqual({ id: "decision-layout", text: "Keep the existing layout." });
    expect(linked?.acceptance_criteria[0]).toEqual({ id: "criterion-plan", text: "The plan is readable.", decision_ids: ["decision-layout"] });
    expect(linked?.acceptance_criteria[1]).toEqual({ id: "criterion-brief", text: "The brief is readable.", decision_ids: [] });
  });

  test("accepts the registered artifact body", () => {
    expect(parsePlan(body).ok).toBe(true);
  });

  test.each([
    ["a string decision", { decisions: ["Keep it small."] }, "cohorts[0].decisions[0]"],
    ["a decision with no id", { decisions: [{ text: "Keep it small." }] }, "cohorts[0].decisions[0].id"],
    ["a decision with a blank id", { decisions: [{ id: "  ", text: "Keep it small." }] }, "cohorts[0].decisions[0].id"],
    ["a string criterion", { acceptance_criteria: ["Tests pass."] }, "cohorts[0].acceptance_criteria[0]"],
    ["a criterion with no id", { acceptance_criteria: [{ text: "Tests pass.", decision_ids: [] }] }, "cohorts[0].acceptance_criteria[0].id"],
    ["a criterion with no decision_ids", { acceptance_criteria: [{ id: "tests-pass", text: "Tests pass." }] }, "cohorts[0].acceptance_criteria[0].decision_ids"],
    ["a string among object criteria", { acceptance_criteria: [criterion, "Tests pass."] }, "cohorts[0].acceptance_criteria[1]"],
  ])("refuses %s, naming the entry", (_, fields, field) => {
    const result = parsePlan({ ...body, cohorts: [{ ...cohort("core"), ...fields }] });
    expect(result.ok ? null : result.error).toMatchObject({ operation: "parse_plan", field });
  });

  test("refuses a bare-string risk", () => {
    const result = parsePlan({ ...body, risks: ["Pin drift"] });
    expect(result.ok ? null : result.error.field).toBe("risks[0]");
  });

  test("refuses a risk with no mitigation", () => {
    const result = parsePlan({ ...body, risks: [{ description: "Pin drift" }] });
    expect(result.ok ? null : result.error.field).toBe("risks[0].mitigation");
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
