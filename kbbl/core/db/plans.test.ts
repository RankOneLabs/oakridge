import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { openTestDb } from "./test-db";
import { insertPlan, getPlan, listPlansBySpec, updatePlanFields } from "./plans";
import { mountPlansRoutes } from "../server/handlers/plans";
import { insertProject } from "./projects";
import { insertSpec } from "./specs";

let db: Database;
let app: Hono;

const PROJECT_ID = "proj-1";
const SPEC_ID = "spec-1";

beforeEach(() => {
  db = openTestDb();
  insertProject(db, { id: PROJECT_ID, name: "P", repo_path: "/p" });
  insertSpec(db, { id: SPEC_ID, project_id: PROJECT_ID, title: "Spec 1" });
  app = new Hono();
  mountPlansRoutes(app, { db });
});

afterEach(() => {
  db.close();
});

describe("plans query helpers", () => {
  test("insertPlan returns the row with defaults", () => {
    const plan = insertPlan(db, { id: "pl1", spec_id: SPEC_ID });
    expect(plan.id).toBe("pl1");
    expect(plan.spec_id).toBe(SPEC_ID);
    expect(plan.status).toBe("pending_approval");
    expect(plan.predecessor_plan_id).toBeNull();
    expect(plan.model).toBeNull();
    expect(plan.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("insertPlan stores model and predecessor_plan_id", () => {
    const p1 = insertPlan(db, { id: "pl1", spec_id: SPEC_ID });
    const p2 = insertPlan(db, {
      id: "pl2",
      spec_id: SPEC_ID,
      model: "claude-opus-4-7",
      predecessor_plan_id: p1.id,
    });
    expect(p2.model).toBe("claude-opus-4-7");
    expect(p2.predecessor_plan_id).toBe("pl1");
  });

  test("getPlan returns null for unknown id", () => {
    expect(getPlan(db, "no-such")).toBeNull();
  });

  test("getPlan returns the row after insert", () => {
    insertPlan(db, { id: "pl3", spec_id: SPEC_ID });
    expect(getPlan(db, "pl3")?.spec_id).toBe(SPEC_ID);
  });

  test("listPlansBySpec returns only matching spec plans", () => {
    insertSpec(db, { id: "spec-2", project_id: PROJECT_ID, title: "S2" });
    insertPlan(db, { id: "pla", spec_id: SPEC_ID });
    insertPlan(db, { id: "plb", spec_id: "spec-2" });
    const plans = listPlansBySpec(db, SPEC_ID);
    expect(plans).toHaveLength(1);
    expect(plans[0].id).toBe("pla");
  });

  test("updatePlanFields updates model", () => {
    insertPlan(db, { id: "pl4", spec_id: SPEC_ID });
    const updated = updatePlanFields(db, "pl4", { model: "sonnet-4-6" });
    expect(updated?.model).toBe("sonnet-4-6");
  });

  test("updatePlanFields sets model to null", () => {
    insertPlan(db, { id: "pl5", spec_id: SPEC_ID, model: "old-model" });
    const updated = updatePlanFields(db, "pl5", { model: null });
    expect(updated?.model).toBeNull();
  });

  test("updatePlanFields returns null for unknown id", () => {
    expect(updatePlanFields(db, "nope", { model: "x" })).toBeNull();
  });
});

describe("GET /plans", () => {
  test("returns 400 without spec_id param", async () => {
    const res = await app.request("/plans");
    expect(res.status).toBe(400);
  });

  test("returns empty array for spec with no plans", async () => {
    const res = await app.request(`/plans?spec_id=${SPEC_ID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("returns plans for the given spec", async () => {
    insertPlan(db, { id: "pl1", spec_id: SPEC_ID });
    const res = await app.request(`/plans?spec_id=${SPEC_ID}`);
    const body = (await res.json()) as { id: string }[];
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("pl1");
  });
});

describe("POST /plans", () => {
  test("creates a plan and returns 201", async () => {
    const res = await app.request("/plans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spec_id: SPEC_ID }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { status: string; predecessor_plan_id: null };
    expect(body.status).toBe("pending_approval");
    expect(body.predecessor_plan_id).toBeNull();
  });

  test("auto-promotes spec status to plan_review on plan creation", async () => {
    await app.request("/plans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spec_id: SPEC_ID }),
    });
    const spec = db.prepare<{ status: string }, [string]>("SELECT status FROM specs WHERE id = ?").get(SPEC_ID);
    expect(spec?.status).toBe("plan_review");
  });

  test("returns 404 for unknown spec_id", async () => {
    const res = await app.request("/plans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spec_id: "no-spec" }),
    });
    expect(res.status).toBe(404);
  });

  test("returns 400 for missing spec_id", async () => {
    const res = await app.request("/plans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /plans/:id", () => {
  test("returns 404 for unknown id", async () => {
    const res = await app.request("/plans/nope");
    expect(res.status).toBe(404);
  });

  test("returns the plan by id", async () => {
    insertPlan(db, { id: "known", spec_id: SPEC_ID });
    const res = await app.request("/plans/known");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("known");
  });
});

describe("PATCH /plans/:id", () => {
  test("updates model", async () => {
    insertPlan(db, { id: "p1", spec_id: SPEC_ID });
    const res = await app.request("/plans/p1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "new-model" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { model: string };
    expect(body.model).toBe("new-model");
  });

  test("returns 400 if body contains status", async () => {
    insertPlan(db, { id: "p2", spec_id: SPEC_ID });
    const res = await app.request("/plans/p2", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/status not editable/);
  });

  test("returns 404 for unknown id", async () => {
    const res = await app.request("/plans/nope", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "x" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("hasCycleAfterInsert (via cohort-graph)", () => {
  test("no cycle in linear chain A→B→C", async () => {
    const { hasCycleAfterInsert } = await import("./cohort-graph");
    const plan = insertPlan(db, { id: "plan-g", spec_id: SPEC_ID });
    const mkCohort = (id: string, pos: number) =>
      db
        .prepare<unknown, [string, string, string, number]>(
          "INSERT INTO cohorts (id, plan_id, title, position) VALUES (?, ?, ?, ?) RETURNING *",
        )
        .get(id, plan.id, id, pos);
    mkCohort("A", 1);
    mkCohort("B", 2);
    mkCohort("C", 3);
    db.prepare("INSERT INTO cohort_dependencies (id, from_cohort_id, to_cohort_id) VALUES (?, ?, ?)").run("d1", "A", "B");
    expect(hasCycleAfterInsert(db, "B", "C")).toBe(false);
  });

  test("detects cycle B→A when A→B exists", async () => {
    const { hasCycleAfterInsert } = await import("./cohort-graph");
    const plan = insertPlan(db, { id: "plan-c", spec_id: SPEC_ID });
    const mkCohort = (id: string, pos: number) =>
      db
        .prepare<unknown, [string, string, string, number]>(
          "INSERT INTO cohorts (id, plan_id, title, position) VALUES (?, ?, ?, ?) RETURNING *",
        )
        .get(id, plan.id, id, pos);
    mkCohort("X", 1);
    mkCohort("Y", 2);
    db.prepare("INSERT INTO cohort_dependencies (id, from_cohort_id, to_cohort_id) VALUES (?, ?, ?)").run("d2", "X", "Y");
    expect(hasCycleAfterInsert(db, "Y", "X")).toBe(true);
  });
});
