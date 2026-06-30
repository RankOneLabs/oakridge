import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { openTestDb } from "../../../db/test-db";
import { insertProject } from "../../../db/projects";
import { insertSpec } from "../../../db/specs";
import { insertEpic } from "../../../db/epics";
import { insertPlan } from "../../../db/plans";
import { insertCohort } from "../../../db/cohorts";
import { insertAssessment } from "../../../db/assessments";
import { mountEpicsRoutes } from "../epics";
import { taskTrackerEvents } from "../../../db/events";
import type { Epic } from "../../../types/task-tracker";

const PROJECT_ID = "proj-1";
const SPEC_ID = "spec-1";
const EPIC_ID = "epic-1";
const PLAN_ID = "plan-1";
const DEFAULT_SELECTIONS = {
  planner_model_selection: { runtime: "claude-code" as const, model: "claude-opus-4-8" },
  worker_model_selection: { runtime: "claude-code" as const, model: "claude-sonnet-4-6" },
};

let db: Database;
let app: Hono;

function get(path: string) {
  return app.request(path);
}

function patch(path: string, body: unknown) {
  return app.request(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function del(path: string) {
  return app.request(path, { method: "DELETE" });
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
  app = new Hono();
  mountEpicsRoutes(app, { db });
});

afterEach(() => {
  db.close();
});

// ─── GET /epics ───────────────────────────────────────────────────────────────

describe("GET /epics", () => {
  test("400 when project_id missing", async () => {
    const res = await get("/epics");
    expect(res.status).toBe(400);
  });

  test("returns empty array when no epics", async () => {
    insertProject(db, { id: "proj-2", name: "Q", repo_path: "/q" });
    const res = await get("/epics?project_id=proj-2");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("returns all epics for project", async () => {
    const res = await get(`/epics?project_id=${PROJECT_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Epic[];
    expect(body).toHaveLength(1);
    expect(body[0]!.id).toBe(EPIC_ID);
  });

  test("filters by status", async () => {
    insertSpec(db, { id: "spec-2", project_id: PROJECT_ID, title: "S2" });
    insertEpic(db, {
      ...DEFAULT_SELECTIONS,
      id: "epic-2",
      spec_id: "spec-2",
      project_id: PROJECT_ID,
      title: "S2",
      status: "archived",
      current_stage: "spec",
    });

    const active = (await (await get(`/epics?project_id=${PROJECT_ID}&status=active`)).json()) as Epic[];
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(EPIC_ID);

    const archived = (await (await get(`/epics?project_id=${PROJECT_ID}&status=archived`)).json()) as Epic[];
    expect(archived).toHaveLength(1);
    expect(archived[0]!.id).toBe("epic-2");
  });

  test("400 on invalid status filter", async () => {
    const res = await get(`/epics?project_id=${PROJECT_ID}&status=bogus`);
    expect(res.status).toBe(400);
  });
});

// ─── GET /epics/:id ───────────────────────────────────────────────────────────

describe("GET /epics/:id", () => {
  test("404 for unknown id", async () => {
    const res = await get("/epics/nope");
    expect(res.status).toBe(404);
  });

  test("returns epic with spec, plan=null, cohorts=[], assessment_present=false", async () => {
    const res = await get(`/epics/${EPIC_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      epic: Epic;
      spec: unknown;
      plan: unknown;
      cohorts: unknown[];
      assessment_present: boolean;
    };
    expect(body.epic.id).toBe(EPIC_ID);
    expect(body.epic.planner_model_selection).toEqual({
      runtime: "claude-code",
      model: "claude-opus-4-8",
    });
    expect(body.epic.worker_model_selection).toEqual({
      runtime: "claude-code",
      model: "claude-sonnet-4-6",
    });
    expect(body.spec).not.toBeNull();
    expect(body.plan).toBeNull();
    expect(body.cohorts).toHaveLength(0);
    expect(body.assessment_present).toBe(false);
  });

  test("includes plan and cohorts when plan exists", async () => {
    insertPlan(db, { id: PLAN_ID, spec_id: SPEC_ID });
    insertCohort(db, { id: "c1", plan_id: PLAN_ID, title: "C1", position: 0 });

    const res = await get(`/epics/${EPIC_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plan: { id: string }; cohorts: Array<{ id: string }> };
    expect(body.plan?.id).toBe(PLAN_ID);
    expect(body.cohorts).toHaveLength(1);
    expect(body.cohorts[0]!.id).toBe("c1");
  });

  test("assessment_present is true when assessment exists", async () => {
    insertPlan(db, { id: PLAN_ID, spec_id: SPEC_ID });
    insertAssessment(db, {
      id: "a1",
      plan_id: PLAN_ID,
      summary: "ok",
      deviations_catalog: [],
      gap_analysis: "none",
      fix_plan: "none",
    });

    const res = await get(`/epics/${EPIC_ID}`);
    const body = (await res.json()) as { assessment_present: boolean };
    expect(body.assessment_present).toBe(true);
  });
});

// ─── PATCH /epics/:id/status ──────────────────────────────────────────────────

describe("PATCH /epics/:id/status", () => {
  test("404 for unknown epic", async () => {
    const res = await patch("/epics/nope/status", { status: "archived" });
    expect(res.status).toBe(404);
  });

  test("400 on invalid json", async () => {
    const res = await app.request(`/epics/${EPIC_ID}/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{bad",
    });
    expect(res.status).toBe(400);
  });

  test("400 on disallowed status value (active)", async () => {
    const res = await patch(`/epics/${EPIC_ID}/status`, { status: "active" });
    expect(res.status).toBe(400);
  });

  test("400 on disallowed status value (complete)", async () => {
    const res = await patch(`/epics/${EPIC_ID}/status`, { status: "complete" });
    expect(res.status).toBe(400);
  });

  test("archives an active epic → 200 with archived status", async () => {
    const res = await patch(`/epics/${EPIC_ID}/status`, { status: "archived" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Epic;
    expect(body.status).toBe("archived");
  });

  test("409 when already archived", async () => {
    await patch(`/epics/${EPIC_ID}/status`, { status: "archived" });
    const res = await patch(`/epics/${EPIC_ID}/status`, { status: "archived" });
    expect(res.status).toBe(409);
  });

  test("unarchive: archived → pending", async () => {
    await patch(`/epics/${EPIC_ID}/status`, { status: "archived" });
    const res = await patch(`/epics/${EPIC_ID}/status`, { status: "pending" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Epic;
    expect(body.status).toBe("pending");
  });

  test("409 when trying to unarchive a non-archived epic", async () => {
    const res = await patch(`/epics/${EPIC_ID}/status`, { status: "pending" });
    expect(res.status).toBe(409);
  });

  test("archive emits epic.archived event", async () => {
    let emitted: { epic_id: string } | null = null;
    const unsub = taskTrackerEvents.subscribe("epic.archived", (p) => { emitted = p; });
    try {
      await patch(`/epics/${EPIC_ID}/status`, { status: "archived" });
      expect(emitted).not.toBeNull();
      expect(emitted!.epic_id).toBe(EPIC_ID);
    } finally {
      unsub();
    }
  });

  test("unarchive emits epic.unarchived event", async () => {
    await patch(`/epics/${EPIC_ID}/status`, { status: "archived" });
    let emitted: { epic_id: string } | null = null;
    const unsub = taskTrackerEvents.subscribe("epic.unarchived", (p) => { emitted = p; });
    try {
      await patch(`/epics/${EPIC_ID}/status`, { status: "pending" });
      expect(emitted).not.toBeNull();
      expect(emitted!.epic_id).toBe(EPIC_ID);
    } finally {
      unsub();
    }
  });
});

// ─── DELETE /epics/:id ────────────────────────────────────────────────────────

describe("DELETE /epics/:id", () => {
  test("404 for unknown id", async () => {
    const res = await del("/epics/nope");
    expect(res.status).toBe(404);
  });

  test("204 on successful delete (spec + epic only)", async () => {
    const res = await del(`/epics/${EPIC_ID}`);
    expect(res.status).toBe(204);

    // Both rows gone
    const epicRow = db.prepare("SELECT id FROM epics WHERE id = ?").get(EPIC_ID);
    const specRow = db.prepare("SELECT id FROM specs WHERE id = ?").get(SPEC_ID);
    expect(epicRow).toBeNull();
    expect(specRow).toBeNull();
  });

  test("cascades to plans, cohorts, briefs, assessments, spec_discrepancies", async () => {
    // Build a full chain
    insertPlan(db, { id: PLAN_ID, spec_id: SPEC_ID });
    insertCohort(db, { id: "c1", plan_id: PLAN_ID, title: "C1", position: 0 });
    insertCohort(db, { id: "c2", plan_id: PLAN_ID, title: "C2", position: 1 });
    db.prepare("INSERT INTO cohort_dependencies (id, from_cohort_id, to_cohort_id) VALUES ('dep1','c1','c2')").run();
    db.prepare("INSERT INTO briefs (id, cohort_id, status, goal, files_in_scope, decisions_made, approaches_rejected, next_action) VALUES ('b1','c1','pending_approval','G','[]','[]','[]','NA')").run();
    insertAssessment(db, { id: "a1", plan_id: PLAN_ID, summary: "s", deviations_catalog: [], gap_analysis: "g", fix_plan: "f" });
    db.prepare("INSERT INTO spec_discrepancies (id, spec_id, spec_assumption, code_reality, status) VALUES ('d1', ?, 'A', 'B', 'open')").run(SPEC_ID);

    const res = await del(`/epics/${EPIC_ID}`);
    expect(res.status).toBe(204);

    // All child rows gone
    expect(db.prepare("SELECT COUNT(*) AS cnt FROM assessments WHERE plan_id = ?").get(PLAN_ID)).toMatchObject({ cnt: 0 });
    expect(db.prepare("SELECT COUNT(*) AS cnt FROM briefs WHERE cohort_id = ?").get("c1")).toMatchObject({ cnt: 0 });
    expect(db.prepare("SELECT COUNT(*) AS cnt FROM cohort_dependencies WHERE from_cohort_id = ?").get("c1")).toMatchObject({ cnt: 0 });
    expect(db.prepare("SELECT COUNT(*) AS cnt FROM cohorts WHERE plan_id = ?").get(PLAN_ID)).toMatchObject({ cnt: 0 });
    expect(db.prepare("SELECT COUNT(*) AS cnt FROM plans WHERE spec_id = ?").get(SPEC_ID)).toMatchObject({ cnt: 0 });
    expect(db.prepare("SELECT COUNT(*) AS cnt FROM spec_discrepancies WHERE spec_id = ?").get(SPEC_ID)).toMatchObject({ cnt: 0 });
    expect(db.prepare("SELECT COUNT(*) AS cnt FROM specs WHERE id = ?").get(SPEC_ID)).toMatchObject({ cnt: 0 });
    expect(db.prepare("SELECT COUNT(*) AS cnt FROM epics WHERE id = ?").get(EPIC_ID)).toMatchObject({ cnt: 0 });
  });
});
