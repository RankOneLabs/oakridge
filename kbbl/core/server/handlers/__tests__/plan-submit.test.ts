/**
 * Tests the plan submission gate: plans are created in 'draft' and cannot be
 * approved until the plan_writer agent submits them (POST /plans/:id/submit),
 * which it does only once every cohort has been posted. This prevents the
 * operator from approving a half-written plan.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { openTestDb } from "../../../db/test-db";
import { insertProject } from "../../../db/projects";
import { insertSpec } from "../../../db/specs";
import { insertPlan, getPlan } from "../../../db/plans";
import { insertCohort } from "../../../db/cohorts";
import { mountPlanStatusRoutes } from "../plan-status";

const PROJECT_ID = "proj-1";
const SPEC_ID = "spec-1";
const PLAN_ID = "plan-1";

let db: Database;
let app: Hono;

function post(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function patch(path: string, body: unknown) {
  return app.request(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  db = openTestDb();
  insertProject(db, { id: PROJECT_ID, name: "P", repo_path: "/p" });
  insertSpec(db, { id: SPEC_ID, project_id: PROJECT_ID, title: "S" });
  insertPlan(db, { id: PLAN_ID, spec_id: SPEC_ID });
  app = new Hono();
  mountPlanStatusRoutes(app, { db });
});

afterEach(() => {
  db.close();
});

describe("POST /plans/:id/submit", () => {
  test("a freshly created plan is in draft", () => {
    expect(getPlan(db, PLAN_ID)!.status).toBe("draft");
  });

  test("a draft plan cannot be approved", async () => {
    insertCohort(db, { id: "c1", plan_id: PLAN_ID, title: "A", notes: null, position: 1 });
    const res = await patch(`/plans/${PLAN_ID}/status`, { status: "approved" });
    expect(res.status).toBe(409);
    expect(getPlan(db, PLAN_ID)!.status).toBe("draft");
  });

  test("submitting a draft with at least one cohort moves it to pending_approval", async () => {
    insertCohort(db, { id: "c1", plan_id: PLAN_ID, title: "A", notes: null, position: 1 });
    const res = await post(`/plans/${PLAN_ID}/submit`, {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("pending_approval");
    expect(getPlan(db, PLAN_ID)!.status).toBe("pending_approval");
  });

  test("submitting a draft with no cohorts is rejected", async () => {
    const res = await post(`/plans/${PLAN_ID}/submit`, {});
    expect(res.status).toBe(409);
    expect(getPlan(db, PLAN_ID)!.status).toBe("draft");
  });

  test("after submission the plan can be approved", async () => {
    insertCohort(db, { id: "c1", plan_id: PLAN_ID, title: "A", notes: null, position: 1 });
    expect((await post(`/plans/${PLAN_ID}/submit`, {})).status).toBe(200);
    const res = await patch(`/plans/${PLAN_ID}/status`, { status: "approved" });
    expect(res.status).toBe(200);
    expect(getPlan(db, PLAN_ID)!.status).toBe("approved");
  });

  test("a plan already in pending_approval cannot be submitted again", async () => {
    insertCohort(db, { id: "c1", plan_id: PLAN_ID, title: "A", notes: null, position: 1 });
    expect((await post(`/plans/${PLAN_ID}/submit`, {})).status).toBe(200);
    const res = await post(`/plans/${PLAN_ID}/submit`, {});
    expect(res.status).toBe(409);
  });

  test("submitting an unknown plan returns 404", async () => {
    const res = await post(`/plans/does-not-exist/submit`, {});
    expect(res.status).toBe(404);
  });
});
