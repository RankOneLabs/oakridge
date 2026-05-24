import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openTestDb } from "./test-db";
import { insertProject } from "./projects";
import { insertSpec } from "./specs";
import { insertPlan } from "./plans";
import { insertAssessment, getAssessment, getAssessmentByPlan, listAssessments } from "./assessments";

const PROJECT_ID = "proj-1";
const SPEC_ID = "spec-1";
const PLAN_ID = "plan-1";

const MINIMAL_ASSESSMENT = {
  plan_id: PLAN_ID,
  summary: "All cohorts shipped cleanly.",
  deviations_catalog: [],
  gap_analysis: "No gaps identified.",
  fix_plan: "No action needed.",
};

let db: Database;

beforeEach(() => {
  db = openTestDb();
  insertProject(db, { id: PROJECT_ID, name: "P", repo_path: "/p" });
  insertSpec(db, { id: SPEC_ID, project_id: PROJECT_ID, title: "S" });
  insertPlan(db, { id: PLAN_ID, spec_id: SPEC_ID });
});

afterEach(() => {
  db.close();
});

describe("insertAssessment + getAssessment", () => {
  test("round-trips all fields", () => {
    const a = insertAssessment(db, { id: "a1", ...MINIMAL_ASSESSMENT });
    expect(a.id).toBe("a1");
    expect(a.plan_id).toBe(PLAN_ID);
    expect(a.summary).toBe("All cohorts shipped cleanly.");
    expect(Array.isArray(a.deviations_catalog)).toBe(true);
    expect(a.deviations_catalog).toEqual([]);
    expect(a.gap_analysis).toBe("No gaps identified.");
    expect(a.fix_plan).toBe("No action needed.");
    expect(a.model).toBeNull();
    expect(a.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("stores and parses non-empty deviations_catalog", () => {
    const catalog = [{ cohort_id: "c1", cohort_title: "C", deviations: [{ from: "spec", actual: "built", downstream_impact: "none" }] }];
    const a = insertAssessment(db, { id: "a2", ...MINIMAL_ASSESSMENT, deviations_catalog: catalog });
    expect(a.deviations_catalog).toEqual(catalog);
  });

  test("getAssessment returns null for unknown id", () => {
    expect(getAssessment(db, "nope")).toBeNull();
  });

  test("getAssessment returns parsed row", () => {
    insertAssessment(db, { id: "a3", ...MINIMAL_ASSESSMENT });
    const found = getAssessment(db, "a3");
    expect(found).not.toBeNull();
    expect(found?.plan_id).toBe(PLAN_ID);
    expect(Array.isArray(found?.deviations_catalog)).toBe(true);
  });
});

describe("getAssessmentByPlan", () => {
  test("returns null when no assessments exist for plan", () => {
    expect(getAssessmentByPlan(db, PLAN_ID)).toBeNull();
  });

  test("returns the most-recent of two assessments", async () => {
    insertAssessment(db, { id: "old", ...MINIMAL_ASSESSMENT, summary: "First" });
    // Small delay to ensure distinct created_at
    await new Promise((r) => setTimeout(r, 5));
    insertAssessment(db, { id: "new", ...MINIMAL_ASSESSMENT, summary: "Second" });

    const result = getAssessmentByPlan(db, PLAN_ID);
    expect(result?.id).toBe("new");
    expect(result?.summary).toBe("Second");
  });
});

describe("listAssessments", () => {
  test("returns empty array when none exist", () => {
    expect(listAssessments(db)).toEqual([]);
  });

  test("returns all assessments most-recent first", async () => {
    insertAssessment(db, { id: "a-first", ...MINIMAL_ASSESSMENT });
    await new Promise((r) => setTimeout(r, 5));
    insertAssessment(db, { id: "a-second", ...MINIMAL_ASSESSMENT });

    const all = listAssessments(db);
    expect(all).toHaveLength(2);
    expect(all[0]!.id).toBe("a-second");
    expect(all[1]!.id).toBe("a-first");
  });
});
