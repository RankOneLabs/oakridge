import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { openTestDb } from "../../db/test-db";
import { insertProject } from "../../db/projects";
import { insertSpec } from "../../db/specs";
import { insertPlan } from "../../db/plans";
import { mountAssessmentsRoutes } from "./assessments";
import type { Assessment } from "../../db/assessments";

const PROJECT_ID = "proj-1";
const SPEC_ID = "spec-1";
const PLAN_ID = "plan-1";

const MINIMAL_BODY = {
  plan_id: PLAN_ID,
  summary: "All good.",
  deviations_catalog: [],
  gap_analysis: "None.",
  fix_plan: "None.",
};

let db: Database;
let app: Hono;

function post(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
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
  mountAssessmentsRoutes(app, { db });
});

afterEach(() => {
  db.close();
});

describe("POST /assessments", () => {
  test("201 with assessment row on valid body", async () => {
    const res = await post("/assessments", MINIMAL_BODY);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Assessment;
    expect(body.plan_id).toBe(PLAN_ID);
    expect(body.summary).toBe("All good.");
    expect(Array.isArray(body.deviations_catalog)).toBe(true);
    expect(body.id).toBeDefined();
  });

  test("400 on missing summary", async () => {
    const { summary: _omit, ...noSummary } = MINIMAL_BODY;
    const res = await post("/assessments", noSummary);
    expect(res.status).toBe(400);
  });

  test("400 on invalid json", async () => {
    const res = await app.request("/assessments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  test("404 when plan_id FK fails", async () => {
    const res = await post("/assessments", { ...MINIMAL_BODY, plan_id: "no-such-plan" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/plan not found/);
  });
});

describe("GET /assessments/:id", () => {
  test("404 for unknown id", async () => {
    const res = await app.request("/assessments/nope");
    expect(res.status).toBe(404);
  });

  test("200 with assessment row after POST", async () => {
    const postRes = await post("/assessments", MINIMAL_BODY);
    const created = (await postRes.json()) as Assessment;

    const getRes = await app.request(`/assessments/${created.id}`);
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as Assessment;
    expect(body.id).toBe(created.id);
    expect(body.plan_id).toBe(PLAN_ID);
    expect(Array.isArray(body.deviations_catalog)).toBe(true);
  });
});

describe("GET /plans/:id/assessment", () => {
  test("404 when no assessment exists for plan", async () => {
    const res = await app.request(`/plans/${PLAN_ID}/assessment`);
    expect(res.status).toBe(404);
  });

  test("200 returns the most-recent assessment for the plan", async () => {
    await post("/assessments", { ...MINIMAL_BODY, summary: "First" });
    await new Promise((r) => setTimeout(r, 5));
    await post("/assessments", { ...MINIMAL_BODY, summary: "Second" });

    const res = await app.request(`/plans/${PLAN_ID}/assessment`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Assessment;
    expect(body.summary).toBe("Second");
  });

  test("404 for plan with no assessments (unknown plan_id)", async () => {
    const res = await app.request("/plans/no-such-plan/assessment");
    expect(res.status).toBe(404);
  });
});
