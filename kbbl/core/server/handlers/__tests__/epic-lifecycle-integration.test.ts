/**
 * Integration test for the full Epic lifecycle:
 * POST /specs → simulated spec.approved → PATCH /plans/:id/status approve
 * → simulate plan.completed → POST /assessments
 *
 * Asserts: epic walks pending→active and current_stage spec→plan→build→assess,
 * then reaches complete on assessment POST.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { openTestDb } from "../../../db/test-db";
import { insertProject } from "../../../db/projects";
import { getEpic, getEpicBySpec } from "../../../db/epics";
import { advanceEpicByEvent } from "../../../db/epics";
import { insertSpec } from "../../../db/specs";
import { insertEpic } from "../../../db/epics";
import { insertPlan } from "../../../db/plans";
import { insertCohort } from "../../../db/cohorts";
import { mountSpecsRoutes } from "../specs";
import { mountPlanStatusRoutes } from "../plan-status";
import { mountAssessmentsRoutes } from "../assessments";
import { mountEpicsRoutes } from "../epics";
const PROJECT_ID = "proj-1";

let db: Database;
let app: Hono;

function post(path: string, body: unknown) {
  const payload =
    path === "/specs"
      ? {
          planner_model_selection: { runtime: "claude-code", model: "claude-opus-4-8" },
          worker_model_selection: { runtime: "claude-code", model: "claude-sonnet-4-6" },
          ...(body as Record<string, unknown>),
        }
      : body;
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
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

  app = new Hono();
  mountSpecsRoutes(app, { db });
  mountPlanStatusRoutes(app, { db });
  mountAssessmentsRoutes(app, { db });
  mountEpicsRoutes(app, { db });
});

afterEach(() => {
  db.close();
});

describe("Epic lifecycle: full stage walk", () => {
  test("spec→plan→build→assess→complete via gate crossings", async () => {
    // Step 1: POST /specs creates (pending, spec) epic
    const specRes = await post("/specs", {
      project_id: PROJECT_ID,
      title: "My Spec",
    });
    expect(specRes.status).toBe(201);
    const specBody = (await specRes.json()) as { id: string; epic_id: string };
    const spec_id = specBody.id;
    const epic_id = specBody.epic_id;
    expect(epic_id).toBeTruthy();

    let epic = getEpic(db, epic_id)!;
    expect(epic.status).toBe("pending");
    expect(epic.current_stage).toBe("spec");

    // Step 2: Simulate spec.approved gate crossing (activates epic, advances to plan stage)
    advanceEpicByEvent(db, epic_id, "epic_spec_approved");
    epic = getEpic(db, epic_id)!;
    expect(epic.status).toBe("active");
    expect(epic.current_stage).toBe("plan");

    // Step 3: Create a plan and approve it → epic_plan_approved → build stage
    const plan_id = crypto.randomUUID();
    insertPlan(db, { id: plan_id, spec_id });
    // Update plan to pending_approval so approval works
    db.prepare("UPDATE plans SET status = 'pending_approval' WHERE id = ?").run(plan_id);

    const planApproveRes = await patch(`/plans/${plan_id}/status`, { status: "approved" });
    expect(planApproveRes.status).toBe(200);

    epic = getEpic(db, epic_id)!;
    expect(epic.status).toBe("active");
    expect(epic.current_stage).toBe("build");

    // Step 4: Simulate plan.completed (all cohorts done) → epic_build_done → assess stage
    advanceEpicByEvent(db, epic_id, "epic_build_done");
    epic = getEpic(db, epic_id)!;
    expect(epic.status).toBe("active");
    expect(epic.current_stage).toBe("assess");

    // Step 5: POST /assessments → epic_assess_done fires → complete
    const assessRes = await post("/assessments", {
      plan_id,
      summary: "All good.",
      deviations_catalog: [],
      gap_analysis: "None.",
      fix_plan: "None.",
    });
    expect(assessRes.status).toBe(201);

    epic = getEpic(db, epic_id)!;
    expect(epic.status).toBe("complete");
    expect(epic.current_stage).toBe("assess");
  });

  test("POST /specs response includes epic_id", async () => {
    const res = await post("/specs", { project_id: PROJECT_ID, title: "T" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; epic_id: string };
    expect(body.epic_id).toBeTruthy();

    // The epic exists in DB
    const epic = getEpicBySpec(db, body.id);
    expect(epic).not.toBeNull();
    expect(epic!.id).toBe(body.epic_id);
    expect(epic!.status).toBe("pending");
  });

  test("pending → active on first stage event (implicit bump)", async () => {
    const specRes = await post("/specs", { project_id: PROJECT_ID, title: "T" });
    const { epic_id } = (await specRes.json()) as { id: string; epic_id: string };

    let epic = getEpic(db, epic_id)!;
    expect(epic.status).toBe("pending");

    advanceEpicByEvent(db, epic_id, "epic_spec_approved");
    epic = getEpic(db, epic_id)!;
    expect(epic.status).toBe("active");
    expect(epic.current_stage).toBe("plan");
  });
});

describe("DELETE /epics/:id leaves zero rows in child tables", () => {
  test("no orphaned rows after cascade delete", async () => {
    const SPEC_ID = crypto.randomUUID();
    const EPIC_ID = crypto.randomUUID();
    const PLAN_ID = crypto.randomUUID();
    const C1 = crypto.randomUUID();
    const C2 = crypto.randomUUID();

    insertSpec(db, { id: SPEC_ID, project_id: PROJECT_ID, title: "S" });
    insertEpic(db, {
      id: EPIC_ID,
      spec_id: SPEC_ID,
      project_id: PROJECT_ID,
      title: "S",
      status: "active",
      current_stage: "spec",
      planner_model_selection: { runtime: "claude-code", model: "claude-opus-4-8" },
      worker_model_selection: { runtime: "claude-code", model: "claude-sonnet-4-6" },
    });
    insertPlan(db, { id: PLAN_ID, spec_id: SPEC_ID });
    insertCohort(db, { id: C1, plan_id: PLAN_ID, title: "C1", position: 0 });
    insertCohort(db, { id: C2, plan_id: PLAN_ID, title: "C2", position: 1 });
    db.prepare("INSERT INTO cohort_dependencies (id, from_cohort_id, to_cohort_id) VALUES (?,?,?)").run("d1", C1, C2);
    db.prepare("INSERT INTO briefs (id, cohort_id, status, goal, files_in_scope, decisions_made, approaches_rejected, next_action) VALUES (?,?,?,?,?,?,?,?)").run("b1", C1, "pending_approval", "G", "[]", "[]", "[]", "NA");
    db.prepare("INSERT INTO assessments (id, plan_id, summary, deviations_catalog, gap_analysis, fix_plan) VALUES (?,?,?,?,?,?)").run("a1", PLAN_ID, "s", "[]", "g", "f");
    db.prepare("INSERT INTO spec_discrepancies (id, spec_id, spec_assumption, code_reality, status) VALUES (?,?,?,?,?)").run("disc1", SPEC_ID, "A", "B", "open");

    const res = await app.request(`/epics/${EPIC_ID}`, { method: "DELETE" });
    expect(res.status).toBe(204);

    // Zero rows for this epic's children
    expect(db.prepare<{cnt: number}, [string]>("SELECT COUNT(*) AS cnt FROM epics WHERE id = ?").get(EPIC_ID)!.cnt).toBe(0);
    expect(db.prepare<{cnt: number}, [string]>("SELECT COUNT(*) AS cnt FROM specs WHERE id = ?").get(SPEC_ID)!.cnt).toBe(0);
    expect(db.prepare<{cnt: number}, [string]>("SELECT COUNT(*) AS cnt FROM plans WHERE spec_id = ?").get(SPEC_ID)!.cnt).toBe(0);
    expect(db.prepare<{cnt: number}, [string]>("SELECT COUNT(*) AS cnt FROM cohorts WHERE plan_id = ?").get(PLAN_ID)!.cnt).toBe(0);
    expect(db.prepare<{cnt: number}, [string]>("SELECT COUNT(*) AS cnt FROM cohort_dependencies WHERE from_cohort_id = ?").get(C1)!.cnt).toBe(0);
    expect(db.prepare<{cnt: number}, [string]>("SELECT COUNT(*) AS cnt FROM briefs WHERE cohort_id = ?").get(C1)!.cnt).toBe(0);
    expect(db.prepare<{cnt: number}, [string]>("SELECT COUNT(*) AS cnt FROM assessments WHERE plan_id = ?").get(PLAN_ID)!.cnt).toBe(0);
    expect(db.prepare<{cnt: number}, [string]>("SELECT COUNT(*) AS cnt FROM spec_discrepancies WHERE spec_id = ?").get(SPEC_ID)!.cnt).toBe(0);
  });
});
