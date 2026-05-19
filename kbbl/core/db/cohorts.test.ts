import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { openTestDb } from "./test-db";
import {
  insertCohort,
  getCohort,
  listCohortsByPlan,
  updateCohortFields,
  insertCohortDependency,
  listDependenciesByPlan,
  listDependenciesByCohort,
} from "./cohorts";
import { mountCohortsRoutes } from "../server/handlers/cohorts";
import { insertProject } from "./projects";
import { insertSpec } from "./specs";
import { insertPlan } from "./plans";

// Minimal SessionManager stub — these tests don't exercise session-status
// resolution, so a fixed `undefined` return is enough.
const stubManager = {
  get: (_sid: string) => undefined,
} as unknown as import("../session/session-manager").SessionManager;

let db: Database;
let app: Hono;

const PROJECT_ID = "proj-1";
const SPEC_ID = "spec-1";
const PLAN_ID = "plan-1";

beforeEach(() => {
  db = openTestDb();
  insertProject(db, { id: PROJECT_ID, name: "P", repo_path: "/p" });
  insertSpec(db, { id: SPEC_ID, project_id: PROJECT_ID, title: "S" });
  insertPlan(db, { id: PLAN_ID, spec_id: SPEC_ID });
  app = new Hono();
  mountCohortsRoutes(app, { db, manager: stubManager });
});

afterEach(() => {
  db.close();
});

function mkCohort(id: string, position = 1) {
  return insertCohort(db, { id, plan_id: PLAN_ID, title: id, position });
}

describe("cohorts query helpers", () => {
  test("insertCohort returns the row with defaults", () => {
    const c = mkCohort("c1");
    expect(c.id).toBe("c1");
    expect(c.plan_id).toBe(PLAN_ID);
    expect(c.status).toBe("waiting");
    expect(c.notes).toBeNull();
    expect(c.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("getCohort returns null for unknown id", () => {
    expect(getCohort(db, "nope")).toBeNull();
  });

  test("listCohortsByPlan returns cohorts ordered by position", () => {
    mkCohort("c3", 3);
    mkCohort("c1", 1);
    mkCohort("c2", 2);
    const cohorts = listCohortsByPlan(db, PLAN_ID);
    expect(cohorts.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
  });

  test("updateCohortFields updates position", () => {
    mkCohort("c4", 1);
    const updated = updateCohortFields(db, "c4", { position: 5 });
    expect(updated?.position).toBe(5);
  });

  test("updateCohortFields returns null for unknown id", () => {
    expect(updateCohortFields(db, "nope", { title: "X" })).toBeNull();
  });

  test("insertCohortDependency creates dependency", () => {
    mkCohort("ca", 1);
    mkCohort("cb", 2);
    const dep = insertCohortDependency(db, { id: "d1", from_cohort_id: "ca", to_cohort_id: "cb" });
    expect(dep.from_cohort_id).toBe("ca");
    expect(dep.to_cohort_id).toBe("cb");
  });

  test("listDependenciesByPlan returns all deps for a plan", () => {
    mkCohort("cx", 1);
    mkCohort("cy", 2);
    insertCohortDependency(db, { id: "dx", from_cohort_id: "cx", to_cohort_id: "cy" });
    const deps = listDependenciesByPlan(db, PLAN_ID);
    expect(deps).toHaveLength(1);
    expect(deps[0].id).toBe("dx");
  });

  test("listDependenciesByCohort returns deps where cohort is either side", () => {
    mkCohort("cm", 1);
    mkCohort("cn", 2);
    mkCohort("co", 3);
    insertCohortDependency(db, { id: "dm", from_cohort_id: "cm", to_cohort_id: "cn" });
    insertCohortDependency(db, { id: "dn", from_cohort_id: "cn", to_cohort_id: "co" });
    const deps = listDependenciesByCohort(db, "cn");
    expect(deps).toHaveLength(2);
  });
});

describe("GET /cohorts", () => {
  test("returns 400 without plan_id param", async () => {
    const res = await app.request("/cohorts");
    expect(res.status).toBe(400);
  });

  test("returns empty array for plan with no cohorts", async () => {
    const res = await app.request(`/cohorts?plan_id=${PLAN_ID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe("POST /cohorts", () => {
  test("creates a cohort and returns 201", async () => {
    const res = await app.request("/cohorts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan_id: PLAN_ID, title: "Phase 1", position: 1 }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { status: string; position: number };
    expect(body.status).toBe("waiting");
    expect(body.position).toBe(1);
  });

  test("returns 404 for unknown plan_id", async () => {
    const res = await app.request("/cohorts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan_id: "no-plan", title: "T", position: 1 }),
    });
    expect(res.status).toBe(404);
  });

  test("returns 400 for missing position", async () => {
    const res = await app.request("/cohorts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan_id: PLAN_ID, title: "T" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /cohorts/:id", () => {
  test("returns 404 for unknown id", async () => {
    const res = await app.request("/cohorts/nope");
    expect(res.status).toBe(404);
  });

  test("returns the cohort", async () => {
    mkCohort("known", 1);
    const res = await app.request("/cohorts/known");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("known");
  });
});

describe("PATCH /cohorts/:id", () => {
  test("updates title", async () => {
    mkCohort("p1", 1);
    const res = await app.request("/cohorts/p1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Updated" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string };
    expect(body.title).toBe("Updated");
  });

  test("returns 400 if body contains status", async () => {
    mkCohort("p2", 1);
    const res = await app.request("/cohorts/p2", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/status not editable/);
  });
});

describe("GET /plans/:id/cohort-dependencies", () => {
  test("returns empty array for plan with no dependencies", async () => {
    const res = await app.request(`/plans/${PLAN_ID}/cohort-dependencies`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("returns dependencies for the plan", async () => {
    mkCohort("da", 1);
    mkCohort("db", 2);
    insertCohortDependency(db, { id: "dep1", from_cohort_id: "da", to_cohort_id: "db" });
    const res = await app.request(`/plans/${PLAN_ID}/cohort-dependencies`);
    const body = (await res.json()) as { id: string }[];
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("dep1");
  });
});

describe("POST /cohort-dependencies", () => {
  test("creates a dependency and returns 201", async () => {
    mkCohort("ea", 1);
    mkCohort("eb", 2);
    const res = await app.request("/cohort-dependencies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from_cohort_id: "ea", to_cohort_id: "eb" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { from_cohort_id: string; to_cohort_id: string };
    expect(body.from_cohort_id).toBe("ea");
    expect(body.to_cohort_id).toBe("eb");
  });

  test("returns 404 for unknown cohort ids", async () => {
    const res = await app.request("/cohort-dependencies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from_cohort_id: "no", to_cohort_id: "such" }),
    });
    expect(res.status).toBe(404);
  });

  test("returns 409 cycle when adding back-edge", async () => {
    mkCohort("fa", 1);
    mkCohort("fb", 2);
    insertCohortDependency(db, { id: "dep2", from_cohort_id: "fa", to_cohort_id: "fb" });
    const res = await app.request("/cohort-dependencies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from_cohort_id: "fb", to_cohort_id: "fa" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("cycle");
  });

  test("returns 409 when cohorts belong to different plans", async () => {
    insertSpec(db, { id: "spec-2", project_id: PROJECT_ID, title: "S2" });
    insertPlan(db, { id: "plan-2", spec_id: "spec-2" });
    mkCohort("ga", 1);
    insertCohort(db, { id: "gb", plan_id: "plan-2", title: "gb", position: 1 });
    const res = await app.request("/cohort-dependencies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from_cohort_id: "ga", to_cohort_id: "gb" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/same plan/);
  });

  test("returns 409 when from and to are the same cohort", async () => {
    mkCohort("ha", 1);
    const res = await app.request("/cohort-dependencies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from_cohort_id: "ha", to_cohort_id: "ha" }),
    });
    expect(res.status).toBe(409);
  });

  test("returns 409 when dependency already exists", async () => {
    mkCohort("ia", 1);
    mkCohort("ib", 2);
    await app.request("/cohort-dependencies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from_cohort_id: "ia", to_cohort_id: "ib" }),
    });
    const res = await app.request("/cohort-dependencies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from_cohort_id: "ia", to_cohort_id: "ib" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/already exists/);
  });
});
