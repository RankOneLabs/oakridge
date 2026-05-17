import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { openTestDb } from "./test-db";
import {
  insertBrief,
  getBrief,
  listBriefsByCohort,
  updateBriefFields,
  updateBriefDebrief,
} from "./briefs";
import { mountBriefsRoutes } from "../server/handlers/briefs";
import { insertProject } from "./projects";
import { insertSpec } from "./specs";
import { insertPlan } from "./plans";
import { insertCohort } from "./cohorts";
import type { Brief } from "../types/task-tracker";

let db: Database;
let app: Hono;

const PROJECT_ID = "proj-1";
const SPEC_ID = "spec-1";
const PLAN_ID = "plan-1";
const COHORT_ID = "cohort-1";

const MINIMAL_BRIEF = {
  cohort_id: COHORT_ID,
  goal: "Ship the feature",
  files_in_scope: ["src/foo.ts"],
  decisions_made: [{ decision: "Use SQLite", rationale: "Simple" }],
  approaches_rejected: [{ approach: "Postgres", reason: "Overhead" }],
  next_action: "Write migration",
};

beforeEach(() => {
  db = openTestDb();
  insertProject(db, { id: PROJECT_ID, name: "P", repo_path: "/p" });
  insertSpec(db, { id: SPEC_ID, project_id: PROJECT_ID, title: "S" });
  insertPlan(db, { id: PLAN_ID, spec_id: SPEC_ID });
  insertCohort(db, { id: COHORT_ID, plan_id: PLAN_ID, title: "C1", position: 1 });
  app = new Hono();
  mountBriefsRoutes(app, { db });
});

afterEach(() => {
  db.close();
});

describe("briefs query helpers", () => {
  test("insertBrief deserializes JSON columns", () => {
    const brief = insertBrief(db, { id: "b1", ...MINIMAL_BRIEF });
    expect(brief.id).toBe("b1");
    expect(brief.status).toBe("pending_approval");
    expect(brief.files_in_scope).toEqual(["src/foo.ts"]);
    expect(brief.decisions_made).toEqual([{ decision: "Use SQLite", rationale: "Simple" }]);
    expect(brief.approaches_rejected).toEqual([{ approach: "Postgres", reason: "Overhead" }]);
    expect(brief.next_action).toBe("Write migration");
    expect(brief.debrief).toBeNull();
    expect(brief.predecessor_brief_id).toBeNull();
    expect(brief.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("getBrief returns null for unknown id", () => {
    expect(getBrief(db, "nope")).toBeNull();
  });

  test("getBrief deserializes JSON columns", () => {
    insertBrief(db, { id: "b2", ...MINIMAL_BRIEF });
    const found = getBrief(db, "b2");
    expect(Array.isArray(found?.files_in_scope)).toBe(true);
    expect(Array.isArray(found?.decisions_made)).toBe(true);
  });

  test("listBriefsByCohort returns all briefs for cohort", () => {
    insertBrief(db, { id: "b3", ...MINIMAL_BRIEF });
    insertBrief(db, { id: "b4", ...MINIMAL_BRIEF });
    const briefs = listBriefsByCohort(db, COHORT_ID);
    expect(briefs).toHaveLength(2);
  });

  test("updateBriefFields updates goal and next_action", () => {
    insertBrief(db, { id: "b5", ...MINIMAL_BRIEF });
    const updated = updateBriefFields(db, "b5", { goal: "Updated goal", next_action: "Deploy" });
    expect(updated?.goal).toBe("Updated goal");
    expect(updated?.next_action).toBe("Deploy");
    expect(Array.isArray(updated?.files_in_scope)).toBe(true);
  });

  test("updateBriefFields updates JSON array columns", () => {
    insertBrief(db, { id: "b6", ...MINIMAL_BRIEF });
    const updated = updateBriefFields(db, "b6", {
      files_in_scope: ["src/bar.ts", "src/baz.ts"],
    });
    expect(updated?.files_in_scope).toEqual(["src/bar.ts", "src/baz.ts"]);
  });

  test("updateBriefFields returns null for unknown id", () => {
    expect(updateBriefFields(db, "nope", { goal: "X" })).toBeNull();
  });

  test("updateBriefDebrief sets debrief", () => {
    insertBrief(db, { id: "b7", ...MINIMAL_BRIEF });
    const updated = updateBriefDebrief(db, "b7", { debrief: "All went well" });
    expect(updated?.debrief).toBe("All went well");
  });

  test("updateBriefDebrief sets pr_url when provided", () => {
    insertBrief(db, { id: "b8", ...MINIMAL_BRIEF });
    const updated = updateBriefDebrief(db, "b8", {
      debrief: "Shipped",
      pr_url: "https://github.com/org/repo/pull/1",
    });
    expect(updated?.debrief).toBe("Shipped");
    expect(updated?.pr_url).toBe("https://github.com/org/repo/pull/1");
  });

  test("updateBriefDebrief returns null for unknown id", () => {
    expect(updateBriefDebrief(db, "nope", { debrief: "debrief" })).toBeNull();
  });
});

describe("GET /briefs", () => {
  test("returns 400 without cohort_id param", async () => {
    const res = await app.request("/briefs");
    expect(res.status).toBe(400);
  });

  test("returns empty array for cohort with no briefs", async () => {
    const res = await app.request(`/briefs?cohort_id=${COHORT_ID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe("POST /briefs", () => {
  test("creates a brief and returns 201 with parsed JSON fields", async () => {
    const res = await app.request("/briefs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(MINIMAL_BRIEF),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Brief;
    expect(body.status).toBe("pending_approval");
    expect(body.predecessor_brief_id).toBeNull();
    expect(Array.isArray(body.files_in_scope)).toBe(true);
    expect(body.files_in_scope[0]).toBe("src/foo.ts");
  });

  test("returns 404 for unknown cohort_id", async () => {
    const res = await app.request("/briefs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...MINIMAL_BRIEF, cohort_id: "no-cohort" }),
    });
    expect(res.status).toBe(404);
  });

  test("returns 400 for missing goal", async () => {
    const { goal: _omit, ...noGoal } = MINIMAL_BRIEF;
    const res = await app.request("/briefs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(noGoal),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /briefs/:id", () => {
  test("returns 404 for unknown id", async () => {
    const res = await app.request("/briefs/nope");
    expect(res.status).toBe(404);
  });

  test("returns the brief with parsed JSON columns", async () => {
    insertBrief(db, { id: "known", ...MINIMAL_BRIEF });
    const res = await app.request("/briefs/known");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Brief;
    expect(body.id).toBe("known");
    expect(Array.isArray(body.decisions_made)).toBe(true);
  });
});

describe("PATCH /briefs/:id", () => {
  test("updates goal", async () => {
    insertBrief(db, { id: "p1", ...MINIMAL_BRIEF });
    const res = await app.request("/briefs/p1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "New goal" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Brief;
    expect(body.goal).toBe("New goal");
    expect(Array.isArray(body.files_in_scope)).toBe(true);
  });

  test("returns 400 if body contains status", async () => {
    insertBrief(db, { id: "p2", ...MINIMAL_BRIEF });
    const res = await app.request("/briefs/p2", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/status not editable/);
  });

  test("returns 400 if body contains debrief", async () => {
    insertBrief(db, { id: "p3", ...MINIMAL_BRIEF });
    const res = await app.request("/briefs/p3", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ debrief: "text" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/debrief not editable/);
  });

  test("returns 404 for unknown id", async () => {
    const res = await app.request("/briefs/nope", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "X" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /briefs/:id/debrief", () => {
  test("writes debrief and returns updated brief", async () => {
    insertBrief(db, { id: "d1", ...MINIMAL_BRIEF });
    const res = await app.request("/briefs/d1/debrief", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ debrief: "Everything shipped cleanly." }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Brief;
    expect(body.debrief).toBe("Everything shipped cleanly.");
  });

  test("returns 400 for missing debrief field", async () => {
    insertBrief(db, { id: "d2", ...MINIMAL_BRIEF });
    const res = await app.request("/briefs/d2/debrief", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("returns 404 for unknown id", async () => {
    const res = await app.request("/briefs/nope/debrief", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ debrief: "text" }),
    });
    expect(res.status).toBe(404);
  });

  test("allowed regardless of brief status", async () => {
    insertBrief(db, { id: "d3", ...MINIMAL_BRIEF });
    const res = await app.request("/briefs/d3/debrief", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ debrief: "Works on any status." }),
    });
    expect(res.status).toBe(200);
  });
});
