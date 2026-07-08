import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openTestDb } from "./test-db";
import { insertProject } from "./projects";
import { insertSpec } from "./specs";
import { insertPlan } from "./plans";
import { insertCohort, getCohort } from "./cohorts";
import { transitionCohort, transitionCohortFromRow } from "./cohort-transitions";

let db: Database;

beforeEach(() => {
  db = openTestDb();
  insertProject(db, { id: "proj-1", name: "P", repo_path: "/p" });
  insertSpec(db, { id: "spec-1", project_id: "proj-1", title: "S" });
  insertPlan(db, { id: "plan-1", spec_id: "spec-1" });
});

afterEach(() => {
  db.close();
});

describe("transitionCohort", () => {
  test("returns trace context for missing cohorts", () => {
    const result = transitionCohort(db, "missing", "build_completed");

    expect(result).toEqual({
      ok: false,
      reason: "not_found",
      operation: "transitionCohort",
      cohort_id: "missing",
      event: "build_completed",
      detail: "cohort not found",
    });
  });

  test("uses a compare-and-set update and rejects stale writes", () => {
    insertCohort(db, { id: "cohort-1", plan_id: "plan-1", title: "C", position: 1 });
    db.prepare("UPDATE cohorts SET status = 'building' WHERE id = 'cohort-1'").run();
    const stale = getCohort(db, "cohort-1");
    if (!stale) throw new Error("expected cohort");
    db.prepare(
      "UPDATE cohorts SET status = 'blocked', pre_block_status = 'building' WHERE id = 'cohort-1'",
    ).run();

    const result = transitionCohortFromRow(db, stale, "build_completed");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_transition");
      expect(result.operation).toBe("transitionCohort");
      expect(result.cohort_id).toBe("cohort-1");
      expect(result.event).toBe("build_completed");
      expect(result.detail).toContain("cohort changed during transition");
    }
    const cohort = getCohort(db, "cohort-1");
    expect(cohort?.status).toBe("blocked");
    expect(cohort?.pre_block_status).toBe("building");
  });
});
