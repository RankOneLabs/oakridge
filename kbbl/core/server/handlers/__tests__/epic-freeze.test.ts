/**
 * Tests that every Epic-owned artifact mutating handler returns 409
 * 'epic is archived' when the Epic is archived, and resumes normal
 * operation after the Epic is unarchived (PATCH /epics/:id/status pending).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { openTestDb } from "../../../db/test-db";
import { insertProject } from "../../../db/projects";
import { insertSpec } from "../../../db/specs";
import { insertEpic } from "../../../db/epics";
import { insertPlan } from "../../../db/plans";
import { insertCohort } from "../../../db/cohorts";
import { mountSpecsRoutes } from "../specs";
import { mountSpecStatusRoutes } from "../spec-status";
import { mountSpecDiscrepanciesRoutes } from "../spec-discrepancies";
import { mountPlansRoutes } from "../plans";
import { mountPlanStatusRoutes } from "../plan-status";
import { mountPlanReopenRoutes } from "../plan-reopen";
import { mountCohortsRoutes } from "../cohorts";
import { mountCohortStatusRoutes } from "../cohort-status";
import { mountCohortMergeRoutes, type GhGateway } from "../cohort-merge";
import { mountBriefsRoutes } from "../briefs";
import { mountBriefStatusRoutes } from "../brief-status";
import { mountBuildsRoutes } from "../builds";
import { mountAssessmentsRoutes } from "../assessments";
import { mountEpicsRoutes } from "../epics";
import type { createDispatcher } from "../../../orchestrator/backends/dispatcher";

const PROJECT_ID = "proj-1";
const SPEC_ID = "spec-1";
const EPIC_ID = "epic-1";
const PLAN_ID = "plan-1";
const COHORT_ID = "cohort-1";
const BRIEF_ID = "brief-1";
const APPROVED_BRIEF_ID = "brief-approved-1";
const DEP_ID = "dep-1";
const COHORT2_ID = "cohort-2";
const DISC_ID = "disc-1";
const DEFAULT_SELECTIONS = {
  planner_model_selection: { runtime: "claude-code" as const, model: "claude-opus-4-8" },
  worker_model_selection: { runtime: "claude-code" as const, model: "claude-sonnet-4-6" },
};

let db: Database;
let app: Hono;

const stubManager = { get: (_sid: string) => undefined } as unknown as import("../../../session/session-manager").SessionManager;

// Panics if dispatch is ever called — ensures archive guard runs before dispatch claim
const panicDispatcher = {
  dispatch: async () => { throw new Error("dispatch must not be called on an archived epic"); },
} as unknown as ReturnType<typeof createDispatcher>;

// Panics if gh is ever called — ensures archive guard runs before merge operations
const panicGh: GhGateway = {
  fetchPrState: async () => { throw new Error("gh must not be called on an archived epic"); },
  mergePr: async () => { throw new Error("gh must not be called on an archived epic"); },
};

function patch(path: string, body: unknown) {
  return app.request(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function post(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function del(path: string) {
  return app.request(path, { method: "DELETE" });
}

async function archiveEpic() {
  const res = await patch(`/epics/${EPIC_ID}/status`, { status: "archived" });
  expect(res.status).toBe(200);
}

async function unarchiveEpic() {
  const res = await patch(`/epics/${EPIC_ID}/status`, { status: "pending" });
  expect(res.status).toBe(200);
}

beforeEach(() => {
  db = openTestDb();
  insertProject(db, { id: PROJECT_ID, name: "P", repo_path: "/p" });
  insertSpec(db, { id: SPEC_ID, project_id: PROJECT_ID, title: "S" });
  insertEpic(db, {
    ...DEFAULT_SELECTIONS,
    id: EPIC_ID,
    spec_id: SPEC_ID,
    project_id: PROJECT_ID,
    title: "S",
    status: "active",
    current_stage: "spec",
  });
  insertPlan(db, { id: PLAN_ID, spec_id: SPEC_ID });
  insertCohort(db, { id: COHORT_ID, plan_id: PLAN_ID, title: "C1", position: 0 });
  insertCohort(db, { id: COHORT2_ID, plan_id: PLAN_ID, title: "C2", position: 1 });
  db.prepare(
    "INSERT INTO cohort_dependencies (id, from_cohort_id, to_cohort_id) VALUES (?,?,?)",
  ).run(DEP_ID, COHORT_ID, COHORT2_ID);
  db.prepare(
    "INSERT INTO briefs (id, cohort_id, status, goal, files_in_scope, decisions_made, approaches_rejected, next_action) VALUES (?,?,?,?,?,?,?,?)",
  ).run(BRIEF_ID, COHORT_ID, "pending_approval", "G", "[]", "[]", "[]", "NA");
  // Approved brief for build-launch tests
  db.prepare(
    "INSERT INTO briefs (id, cohort_id, status, goal, files_in_scope, decisions_made, approaches_rejected, next_action) VALUES (?,?,?,?,?,?,?,?)",
  ).run(APPROVED_BRIEF_ID, COHORT_ID, "approved", "G", "[]", "[]", "[]", "NA");
  db.prepare(
    "INSERT INTO spec_discrepancies (id, spec_id, spec_assumption, code_reality, status) VALUES (?,?,?,?,?)",
  ).run(DISC_ID, SPEC_ID, "A", "B", "open");

  app = new Hono();
  mountSpecsRoutes(app, { db });
  mountSpecStatusRoutes(app, { db });
  mountSpecDiscrepanciesRoutes(app, { db });
  mountPlansRoutes(app, { db });
  mountPlanStatusRoutes(app, { db });
  mountPlanReopenRoutes(app, { db });
  mountCohortsRoutes(app, { db, manager: stubManager });
  mountCohortStatusRoutes(app, { db });
  mountCohortMergeRoutes(app, { db, gh: panicGh });
  mountBriefsRoutes(app, { db });
  mountBriefStatusRoutes(app, { db });
  mountBuildsRoutes(app, { db, dispatcher: panicDispatcher, manager: stubManager });
  mountAssessmentsRoutes(app, { db });
  mountEpicsRoutes(app, { db });
});

afterEach(() => {
  db.close();
});

// ─── Each gated route returns 409 when frozen ─────────────────────────────────

describe("freeze: 409 'epic is archived' on all mutating routes", () => {
  beforeEach(async () => {
    await archiveEpic();
  });

  test("PATCH /specs/:id → 409", async () => {
    const res = await patch(`/specs/${SPEC_ID}`, { title: "New" });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe("epic is archived");
  });

  test("PATCH /specs/:id/internal-status → 409", async () => {
    const res = await patch(`/specs/${SPEC_ID}/internal-status`, { internal_status: "discrepancies" });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe("epic is archived");
  });

  test("POST /spec-discrepancies → 409", async () => {
    const res = await post("/spec-discrepancies", {
      spec_id: SPEC_ID,
      spec_assumption: "X",
      code_reality: "Y",
    });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe("epic is archived");
  });

  test("PATCH /spec-discrepancies/:id → 409", async () => {
    const res = await patch(`/spec-discrepancies/${DISC_ID}`, {
      resolution: "fixed",
      status: "resolved",
    });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe("epic is archived");
  });

  test("POST /plans → 409", async () => {
    const res = await post("/plans", { spec_id: SPEC_ID });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe("epic is archived");
  });

  test("PATCH /plans/:id → 409", async () => {
    const res = await patch(`/plans/${PLAN_ID}`, { model: "claude-opus" });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe("epic is archived");
  });

  test("PATCH /plans/:id/status → 409", async () => {
    const res = await patch(`/plans/${PLAN_ID}/status`, { status: "rejected", reason: "bad" });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe("epic is archived");
  });

  test("POST /cohorts → 409", async () => {
    const res = await post("/cohorts", { plan_id: PLAN_ID, title: "New", position: 99 });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe("epic is archived");
  });

  test("PATCH /cohorts/:id → 409", async () => {
    const res = await patch(`/cohorts/${COHORT_ID}`, { title: "New" });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe("epic is archived");
  });

  test("POST /cohort-dependencies → 409", async () => {
    // need a third cohort for this
    insertCohort(db, { id: "cohort-3", plan_id: PLAN_ID, title: "C3", position: 2 });
    const res = await post("/cohort-dependencies", {
      from_cohort_id: COHORT_ID,
      to_cohort_id: "cohort-3",
    });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe("epic is archived");
  });

  test("DELETE /cohort-dependencies/:id → 409", async () => {
    const res = await del(`/cohort-dependencies/${DEP_ID}`);
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe("epic is archived");
  });

  test("PATCH /cohorts/:id/status → 409", async () => {
    const res = await patch(`/cohorts/${COHORT_ID}/status`, { status: "blocked" });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe("epic is archived");
  });

  test("POST /briefs → 409", async () => {
    const res = await post("/briefs", {
      cohort_id: COHORT_ID,
      goal: "G",
      files_in_scope: [],
      decisions_made: [],
      approaches_rejected: [],
      next_action: "NA",
    });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe("epic is archived");
  });

  test("PATCH /briefs/:id → 409", async () => {
    const res = await patch(`/briefs/${BRIEF_ID}`, { goal: "New" });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe("epic is archived");
  });

  test("PATCH /briefs/:id/status → 409", async () => {
    const res = await patch(`/briefs/${BRIEF_ID}/status`, { status: "rejected", reason: "bad" });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe("epic is archived");
  });

  test("POST /assessments → 409", async () => {
    const res = await post("/assessments", {
      plan_id: PLAN_ID,
      summary: "ok",
      deviations_catalog: [],
      gap_analysis: "none",
      fix_plan: "none",
    });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe("epic is archived");
  });

  test("POST /briefs/:id/build → 409, no dispatch or session created", async () => {
    const res = await post(`/briefs/${APPROVED_BRIEF_ID}/build`, {});
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe("epic is archived");
  });

  test("POST /cohorts/:id/merge → 409", async () => {
    // Cohort status doesn't matter — archive check runs before status check
    const res = await post(`/cohorts/${COHORT_ID}/merge`, {});
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe("epic is archived");
  });

  test("POST /plans/:id/reopen → 409", async () => {
    const res = await post(`/plans/${PLAN_ID}/reopen`, {});
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe("epic is archived");
  });

  test("POST /briefs/:id/reopen → 409", async () => {
    const res = await post(`/briefs/${BRIEF_ID}/reopen`, {});
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe("epic is archived");
  });
});

// ─── Unarchive restores writability ───────────────────────────────────────────

describe("unarchive restores writability", () => {
  test("PATCH /specs/:id works after unarchive", async () => {
    await archiveEpic();
    await unarchiveEpic();
    const res = await patch(`/specs/${SPEC_ID}`, { title: "Updated" });
    expect(res.status).toBe(200);
  });

  test("POST /spec-discrepancies works after unarchive", async () => {
    await archiveEpic();
    await unarchiveEpic();
    const res = await post("/spec-discrepancies", {
      spec_id: SPEC_ID,
      spec_assumption: "X",
      code_reality: "Y",
    });
    expect(res.status).toBe(201);
  });
});

// ─── GET routes are not gated ─────────────────────────────────────────────────

describe("GET routes not blocked by freeze", () => {
  test("GET /specs/:id works when archived", async () => {
    await archiveEpic();
    const res = await app.request(`/specs/${SPEC_ID}`);
    expect(res.status).toBe(200);
  });

  test("GET /epics/:id works when archived", async () => {
    await archiveEpic();
    const res = await app.request(`/epics/${EPIC_ID}`);
    expect(res.status).toBe(200);
  });
});
