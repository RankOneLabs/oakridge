import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { openTestDb } from "../db/test-db";
import { reviewRegistry } from "../review/registry";
import { reviewEvents } from "../review/events";
import { taskTrackerEvents } from "../db/events";
import { bootstrap } from "./bootstrap";
import { mountProjectsRoutes } from "../server/handlers/projects";
import { mountSpecsRoutes } from "../server/handlers/specs";
import { mountPlansRoutes } from "../server/handlers/plans";
import { mountPlanStatusRoutes } from "../server/handlers/plan-status";
import { mountCohortsRoutes } from "../server/handlers/cohorts";
import { mountCohortStatusRoutes } from "../server/handlers/cohort-status";
import { mountBriefsRoutes } from "../server/handlers/briefs";
import { mountBriefStatusRoutes } from "../server/handlers/brief-status";
import type { TaskTrackerEventMap } from "../db/events";

let db: Database;
let app: Hono;

beforeEach(() => {
  db = openTestDb();
  bootstrap({ db, registry: reviewRegistry, reviewEvents, taskTrackerEvents });
  app = new Hono();
  mountProjectsRoutes(app, { db });
  mountSpecsRoutes(app, { db });
  mountPlansRoutes(app, { db });
  mountPlanStatusRoutes(app, { db });
  mountCohortsRoutes(app, { db });
  mountCohortStatusRoutes(app, { db });
  mountBriefsRoutes(app, { db });
  mountBriefStatusRoutes(app, { db });
});

afterEach(() => {
  db.close();
});

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

function get(path: string) {
  return app.request(path);
}

describe("full lifecycle — two-cohort plan with dependency", () => {
  test("POST /projects → /specs → /plans → /cohorts (A,B) → /cohort-dependencies (A→B) → approve plan → A planned B waiting → POST /briefs → A brief_review → approve brief → A building → mark A done → B planned", async () => {
    const fired: Partial<Record<keyof TaskTrackerEventMap, unknown[]>> = {};
    const unsubs: (() => void)[] = [];

    const track = <K extends keyof TaskTrackerEventMap>(event: K) => {
      const list: TaskTrackerEventMap[K][] = [];
      fired[event] = list as unknown[];
      unsubs.push(
        taskTrackerEvents.subscribe(event, (p) => {
          (list as TaskTrackerEventMap[K][]).push(p);
        }),
      );
    };

    track("plan.approved");
    track("cohort.entered_planned");
    track("brief.submitted");
    track("brief.approved");
    track("cohort.done");

    try {
      // --- project ---
      const projRes = await post("/projects", { name: "test-project", repo_path: "/tmp/test" });
      expect(projRes.status).toBe(201);
      const proj = (await projRes.json()) as { id: string };

      // --- spec ---
      const specRes = await post("/specs", { project_id: proj.id, title: "My spec" });
      expect(specRes.status).toBe(201);
      const spec = (await specRes.json()) as { id: string; status: string };
      expect(spec.status).toBe("draft");

      // --- plan ---
      const planRes = await post("/plans", { spec_id: spec.id });
      expect(planRes.status).toBe(201);
      const plan = (await planRes.json()) as { id: string; status: string };
      expect(plan.status).toBe("pending_approval");

      // spec promoted to plan_review by POST /plans
      const specAfterPlan = (await (await get(`/specs/${spec.id}`)).json()) as { status: string };
      expect(specAfterPlan.status).toBe("plan_review");

      // --- cohort A (no deps) ---
      const cohortARes = await post("/cohorts", { plan_id: plan.id, title: "Cohort A", position: 1 });
      expect(cohortARes.status).toBe(201);
      const cohortA = (await cohortARes.json()) as { id: string; status: string };
      expect(cohortA.status).toBe("waiting");

      // --- cohort B (depends on A) ---
      const cohortBRes = await post("/cohorts", { plan_id: plan.id, title: "Cohort B", position: 2 });
      expect(cohortBRes.status).toBe(201);
      const cohortB = (await cohortBRes.json()) as { id: string; status: string };
      expect(cohortB.status).toBe("waiting");

      // --- dependency: A → B (A must complete before B) ---
      const depRes = await post("/cohort-dependencies", {
        from_cohort_id: cohortA.id,
        to_cohort_id: cohortB.id,
      });
      expect(depRes.status).toBe(201);

      // --- approve plan ---
      const approveRes = await patch(`/plans/${plan.id}/status`, { status: "approved" });
      expect(approveRes.status).toBe(200);
      const approvedPlan = (await approveRes.json()) as { status: string };
      expect(approvedPlan.status).toBe("approved");

      // A should be planned (leaf), B still waiting (has dep on A)
      const aAfterApproval = (await (await get(`/cohorts/${cohortA.id}`)).json()) as { status: string };
      expect(aAfterApproval.status).toBe("planned");

      const bAfterApproval = (await (await get(`/cohorts/${cohortB.id}`)).json()) as { status: string };
      expect(bAfterApproval.status).toBe("waiting");

      // Events: plan.approved + cohort.entered_planned for A only
      expect((fired["plan.approved"] as unknown[]).length).toBe(1);
      expect((fired["cohort.entered_planned"] as unknown[]).length).toBe(1);
      expect((fired["cohort.entered_planned"] as Array<{ cohort_id: string }>)[0]!.cohort_id).toBe(cohortA.id);

      // spec should be planning_done
      const specAfterApproval = (await (await get(`/specs/${spec.id}`)).json()) as { status: string };
      expect(specAfterApproval.status).toBe("planning_done");

      // --- POST /briefs for A (cohort must be in briefing first; transition planned→briefing is
      //     orchestrator-driven in a real flow, but for the test we manually advance it) ---
      // Advance A to briefing via a direct DB update to match the test scenario from the brief
      db.prepare("UPDATE cohorts SET status = 'briefing' WHERE id = ?").run(cohortA.id);

      const briefRes = await post("/briefs", {
        cohort_id: cohortA.id,
        goal: "Build the feature",
        files_in_scope: ["src/index.ts"],
        decisions_made: [{ decision: "Use TypeScript", rationale: "Type safety" }],
        approaches_rejected: [],
        next_action: "Start coding",
      });
      expect(briefRes.status).toBe(201);
      const brief = (await briefRes.json()) as { id: string; status: string };

      // brief.submitted should have fired, which bootstrap handled to transition cohort A briefing→brief_review
      expect((fired["brief.submitted"] as unknown[]).length).toBe(1);

      const aAfterBrief = (await (await get(`/cohorts/${cohortA.id}`)).json()) as { status: string };
      expect(aAfterBrief.status).toBe("brief_review");

      // --- approve brief ---
      const approveBriefRes = await patch(`/briefs/${brief.id}/status`, { status: "approved" });
      expect(approveBriefRes.status).toBe(200);
      const approvedBrief = (await approveBriefRes.json()) as { status: string };
      expect(approvedBrief.status).toBe("approved");

      // A should now be building
      const aAfterBriefApproval = (await (await get(`/cohorts/${cohortA.id}`)).json()) as { status: string };
      expect(aAfterBriefApproval.status).toBe("building");

      expect((fired["brief.approved"] as unknown[]).length).toBe(1);

      // --- mark A done ---
      const doneRes = await patch(`/cohorts/${cohortA.id}/status`, { status: "done" });
      expect(doneRes.status).toBe(200);
      const doneCohort = (await doneRes.json()) as { status: string };
      expect(doneCohort.status).toBe("done");

      // B should now be planned (its only dep, A, is done)
      const bAfterADone = (await (await get(`/cohorts/${cohortB.id}`)).json()) as { status: string };
      expect(bAfterADone.status).toBe("planned");

      // Events: cohort.done for A, cohort.entered_planned for B
      expect((fired["cohort.done"] as unknown[]).length).toBe(1);
      // Total cohort.entered_planned: 1 (A from plan approval) + 1 (B from A done) = 2
      expect((fired["cohort.entered_planned"] as unknown[]).length).toBe(2);
      const plannedIds = (fired["cohort.entered_planned"] as Array<{ cohort_id: string }>).map((e) => e.cohort_id);
      expect(plannedIds).toContain(cohortA.id);
      expect(plannedIds).toContain(cohortB.id);
    } finally {
      for (const unsub of unsubs) unsub();
    }
  });

  test("PATCH /cohorts/:id/status blocked/unblocked round-trip preserves prior state", async () => {
    const projRes = await post("/projects", { name: "p2", repo_path: "/tmp/p2" });
    const proj = (await projRes.json()) as { id: string };
    const specRes = await post("/specs", { project_id: proj.id, title: "s" });
    const spec = (await specRes.json()) as { id: string };
    const planRes = await post("/plans", { spec_id: spec.id });
    const plan = (await planRes.json()) as { id: string };
    const cohortRes = await post("/cohorts", { plan_id: plan.id, title: "C", position: 1 });
    const cohort = (await cohortRes.json()) as { id: string; status: string };
    expect(cohort.status).toBe("waiting");

    // Block it
    const blockRes = await patch(`/cohorts/${cohort.id}/status`, { status: "blocked" });
    expect(blockRes.status).toBe(200);
    const blocked = (await blockRes.json()) as { status: string; pre_block_status: string };
    expect(blocked.status).toBe("blocked");
    expect(blocked.pre_block_status).toBe("waiting");

    // Unblock it — should restore to waiting
    const unblockRes = await patch(`/cohorts/${cohort.id}/status`, { status: "unblocked" });
    expect(unblockRes.status).toBe(200);
    const unblocked = (await unblockRes.json()) as { status: string; pre_block_status: string | null };
    expect(unblocked.status).toBe("waiting");
    expect(unblocked.pre_block_status).toBeNull();
  });

  test("PATCH /cohorts/:id/status with arbitrary status returns 422", async () => {
    const projRes = await post("/projects", { name: "p3", repo_path: "/tmp/p3" });
    const proj = (await projRes.json()) as { id: string };
    const specRes = await post("/specs", { project_id: proj.id, title: "s" });
    const spec = (await specRes.json()) as { id: string };
    const planRes = await post("/plans", { spec_id: spec.id });
    const plan = (await planRes.json()) as { id: string };
    const cohortRes = await post("/cohorts", { plan_id: plan.id, title: "C", position: 1 });
    const cohort = (await cohortRes.json()) as { id: string };

    const res = await patch(`/cohorts/${cohort.id}/status`, { status: "planned" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("transition is orchestrator-only");
  });

  test("plan rejection stores reason; plan not in pending_approval returns 409", async () => {
    const projRes = await post("/projects", { name: "p4", repo_path: "/tmp/p4" });
    const proj = (await projRes.json()) as { id: string };
    const specRes = await post("/specs", { project_id: proj.id, title: "s" });
    const spec = (await specRes.json()) as { id: string };
    const planRes = await post("/plans", { spec_id: spec.id });
    const plan = (await planRes.json()) as { id: string };

    const rejectRes = await patch(`/plans/${plan.id}/status`, { status: "rejected", reason: "needs more work" });
    expect(rejectRes.status).toBe(200);
    const rejected = (await rejectRes.json()) as { status: string; rejection_reason: string };
    expect(rejected.status).toBe("rejected");
    expect(rejected.rejection_reason).toBe("needs more work");

    // Double-reject: 409
    const doubleRes = await patch(`/plans/${plan.id}/status`, { status: "rejected" });
    expect(doubleRes.status).toBe(409);
  });
});
