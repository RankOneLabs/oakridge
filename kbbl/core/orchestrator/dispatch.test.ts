/**
 * End-to-end integration test with a MockBackend.
 *
 * Drives the full lifecycle: POST /specs → planner1 dispatch →
 * plan + cohorts → plan approval → planner2 dispatch → brief → brief
 * approval → build dispatch → debrief PATCH.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { openTestDb } from "../db/test-db";
import { reviewRegistry } from "../review/registry";
import { reviewEvents } from "../review/events";
import { taskTrackerEvents } from "../db/events";
import { bootstrap } from "./bootstrap";
import { createDispatcher } from "./backends/dispatcher";
import { wireDispatchHooks } from "./dispatch-hooks";
import type { ExecutionBackend, InputRef, StageRow } from "./backends/interface";
import { mountProjectsRoutes } from "../server/handlers/projects";
import { mountSpecsRoutes } from "../server/handlers/specs";
import { mountPlansRoutes } from "../server/handlers/plans";
import { mountPlanStatusRoutes } from "../server/handlers/plan-status";
import { mountPlanReopenRoutes } from "../server/handlers/plan-reopen";
import { mountCohortsRoutes } from "../server/handlers/cohorts";
import { mountCohortStatusRoutes } from "../server/handlers/cohort-status";
import { mountBriefsRoutes } from "../server/handlers/briefs";
import { mountBriefStatusRoutes } from "../server/handlers/brief-status";
import { mountBuildsRoutes } from "../server/handlers/builds";

// ---- minimal SessionManager stub for builds route ----

const stubManager = {
  get: (_sid: string) => undefined,
} as unknown as import("../session/session-manager").SessionManager;

// ---- MockBackend ----

interface DispatchCall {
  stageName: string;
  inputType: string;
  inputId: string;
  renderedPrompt: string;
}

interface MockBackend extends ExecutionBackend {
  calls: DispatchCall[];
}

function createMockBackend(): MockBackend {
  const calls: DispatchCall[] = [];
  return {
    id: "kbbl_chat",
    calls,
    async dispatch(stage: StageRow, inputRef: InputRef, renderedPrompt: string) {
      calls.push({ stageName: stage.name, inputType: inputRef.type, inputId: inputRef.id, renderedPrompt });
      return { session_ref: `mock-${calls.length}` };
    },
    async status(_session_ref: string) {
      return "completed" as const;
    },
  };
}

// ---- fixture prompt dir ----

let promptsDir: string;

function setupPromptFixtures() {
  promptsDir = mkdtempSync(join(tmpdir(), "kbbl-dispatch-test-"));
  // Minimal templates — all required slots, no extras.
  writeFileSync(
    join(promptsDir, "planner1.md"),
    "planner1 {{SPEC_ID}} {{SPEC_TITLE}} {{SPEC_NOTES}} {{REPO_PATH}} {{KBBL_URL}}",
    "utf8",
  );
  writeFileSync(
    join(promptsDir, "planner2.md"),
    "planner2 {{COHORT_ID}} {{COHORT_TITLE}} {{COHORT_NOTES}} {{PLAN_CONTEXT}} {{KBBL_URL}} {{BRIEF_FORMAT_GUIDE}}",
    "utf8",
  );
  writeFileSync(
    join(promptsDir, "build.md"),
    "build {{BRIEF_ID}} {{BRIEF_RENDERED}} {{REPO_PATH}} {{KBBL_URL}}",
    "utf8",
  );
  writeFileSync(
    join(promptsDir, "planner2-batch.md"),
    "planner2_batch {{PLAN_ID}} {{PLAN_TITLE}} {{SPEC_NOTES}} {{COHORTS}} {{PLAN_DEPENDENCIES}} {{KBBL_URL}} {{BRIEF_FORMAT_GUIDE}}",
    "utf8",
  );
  process.env.KBBL_PROMPTS_DIR = promptsDir;
}

// ---- helpers ----

function post(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patch(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Yield to the microtask queue so async event handlers (dispatch hooks) can settle. */
function flushAsync() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ---- test suite ----

let db: Database;
let app: Hono;
let mockBackend: MockBackend;
let cleanupBootstrap: () => void;
let cleanupHooks: () => void;
const origPromptsDir = process.env.KBBL_PROMPTS_DIR;

beforeEach(() => {
  setupPromptFixtures();
  db = openTestDb();
  cleanupBootstrap = bootstrap({ db, registry: reviewRegistry, reviewEvents, taskTrackerEvents });

  mockBackend = createMockBackend();
  const dispatcher = createDispatcher({
    db,
    backends: { kbbl_chat: mockBackend },
    kbblUrl: "http://localhost:8788",
  });
  cleanupHooks = wireDispatchHooks({ taskTrackerEvents, dispatcher });

  app = new Hono();
  mountProjectsRoutes(app, { db });
  mountSpecsRoutes(app, { db });
  mountPlansRoutes(app, { db });
  mountPlanStatusRoutes(app, { db });
  mountPlanReopenRoutes(app, { db });
  mountCohortsRoutes(app, { db, manager: stubManager });
  mountCohortStatusRoutes(app, { db });
  mountBriefsRoutes(app, { db });
  mountBriefStatusRoutes(app, { db });
  mountBuildsRoutes(app, { db, dispatcher, manager: stubManager });
});

afterEach(() => {
  cleanupHooks();
  cleanupBootstrap();
  db.close();
  if (origPromptsDir === undefined) {
    delete process.env.KBBL_PROMPTS_DIR;
  } else {
    process.env.KBBL_PROMPTS_DIR = origPromptsDir;
  }
});

describe("full dispatch pipeline with MockBackend", () => {
  test("POST /specs → planner1 dispatch → plan → cohorts → plan approved → planner2 dispatch → brief → brief approved → build dispatch → debrief PATCH", async () => {
    // 1. Create project + spec
    const projRes = await post(app, "/projects", { name: "test", repo_path: "/tmp/test-repo" });
    expect(projRes.status).toBe(201);
    const proj = (await projRes.json()) as { id: string };

    const specRes = await post(app, "/specs", { project_id: proj.id, title: "My spec", notes: "build X" });
    expect(specRes.status).toBe(201);
    const spec = (await specRes.json()) as { id: string };

    // spec.created fires → dispatch hook triggers planner1 (async)
    await flushAsync();
    expect(mockBackend.calls).toHaveLength(1);
    expect(mockBackend.calls[0]!.stageName).toBe("planner1");
    expect(mockBackend.calls[0]!.inputId).toBe(spec.id);
    // current_session_ref written onto spec
    const specRow = db.prepare<{ current_session_ref: string | null }, [string]>("SELECT current_session_ref FROM specs WHERE id = ?").get(spec.id);
    expect(specRow!.current_session_ref).toBe("mock-1");

    // 2. Agent posts plan + one cohort (no deps → leaf → planned on approval)
    const planRes = await post(app, "/plans", { spec_id: spec.id });
    expect(planRes.status).toBe(201);
    const plan = (await planRes.json()) as { id: string };

    const cohortRes = await post(app, "/cohorts", { plan_id: plan.id, title: "Cohort A", position: 1 });
    expect(cohortRes.status).toBe(201);
    const cohort = (await cohortRes.json()) as { id: string };

    // 3. Approve plan → cohort.entered_planned → planner2 dispatch + briefing_started
    const approveRes = await patch(app, `/plans/${plan.id}/status`, { status: "approved" });
    expect(approveRes.status).toBe(200);

    await flushAsync();
    expect(mockBackend.calls).toHaveLength(2);
    expect(mockBackend.calls[1]!.stageName).toBe("planner2");
    expect(mockBackend.calls[1]!.inputId).toBe(cohort.id);

    // cohort.briefing_started should have transitioned cohort to briefing
    const cohortAfterPlanned = db.prepare<{ status: string }, [string]>("SELECT status FROM cohorts WHERE id = ?").get(cohort.id);
    expect(cohortAfterPlanned!.status).toBe("briefing");

    // current_session_ref on cohort updated
    const cohortRefRow = db.prepare<{ current_session_ref: string | null }, [string]>("SELECT current_session_ref FROM cohorts WHERE id = ?").get(cohort.id);
    expect(cohortRefRow!.current_session_ref).toBe("mock-2");

    // 4. Agent posts brief → brief.submitted → cohort: briefing → brief_review
    const briefRes = await post(app, "/briefs", {
      cohort_id: cohort.id,
      goal: "ship it",
      files_in_scope: ["src/index.ts"],
      decisions_made: [{ decision: "use TS", rationale: "types" }],
      approaches_rejected: [],
      next_action: "start coding",
    });
    expect(briefRes.status).toBe(201);
    const brief = (await briefRes.json()) as { id: string; status: string };
    expect(brief.status).toBe("pending_approval");

    const cohortAfterBrief = db.prepare<{ status: string }, [string]>("SELECT status FROM cohorts WHERE id = ?").get(cohort.id);
    expect(cohortAfterBrief!.status).toBe("brief_review");

    // 5. Approve brief → brief.approved → build dispatch
    const approveBriefRes = await patch(app, `/briefs/${brief.id}/status`, { status: "approved" });
    expect(approveBriefRes.status).toBe(200);

    await flushAsync();
    expect(mockBackend.calls).toHaveLength(3);
    expect(mockBackend.calls[2]!.stageName).toBe("build");
    expect(mockBackend.calls[2]!.inputId).toBe(brief.id);

    // current_session_ref written onto cohort (build stores on cohort, not brief)
    const cohortRefAfterBuild = db.prepare<{ current_session_ref: string | null }, [string]>("SELECT current_session_ref FROM cohorts WHERE id = ?").get(cohort.id);
    expect(cohortRefAfterBuild!.current_session_ref).toBe("mock-3");

    // 6. Agent PATCHes debrief + pr_url
    const debriefRes = await patch(app, `/briefs/${brief.id}/debrief`, {
      debrief: "# Debrief\n\nAll done.",
      pr_url: "https://github.com/org/repo/pull/99",
    });
    expect(debriefRes.status).toBe(200);
    const debriefed = (await debriefRes.json()) as { debrief: string | null; pr_url: string | null };
    expect(debriefed.debrief).toBe("# Debrief\n\nAll done.");
    expect(debriefed.pr_url).toBe("https://github.com/org/repo/pull/99");
  });

  test("dispatcher.dispatch('planner2_batch', plan_id) — toposorted prompt, plan persistence", async () => {
    // 1. Create project + spec + plan
    const projRes = await post(app, "/projects", { name: "batch-test", repo_path: "/tmp/batch-repo" });
    const proj = (await projRes.json()) as { id: string };

    const specRes = await post(app, "/specs", { project_id: proj.id, title: "Batch Spec", notes: "batch notes" });
    const spec = (await specRes.json()) as { id: string };
    await flushAsync(); // planner1 fires — consume that call

    const planRes = await post(app, "/plans", { spec_id: spec.id });
    const plan = (await planRes.json()) as { id: string };

    // 2. Create 3 cohorts: A pos 1, B pos 2, C pos 3
    const cohortARes = await post(app, "/cohorts", { plan_id: plan.id, title: "Cohort A", position: 1 });
    const cohortA = (await cohortARes.json()) as { id: string };

    const cohortBRes = await post(app, "/cohorts", { plan_id: plan.id, title: "Cohort B", position: 2 });
    const cohortB = (await cohortBRes.json()) as { id: string };

    const cohortCRes = await post(app, "/cohorts", { plan_id: plan.id, title: "Cohort C", position: 3 });
    await cohortCRes.json();

    // 3. Add dependency edge: A → B (B depends on A)
    const depRes = await post(app, "/cohort-dependencies", {
      from_cohort_id: cohortA.id,
      to_cohort_id: cohortB.id,
    });
    expect(depRes.status).toBe(201);

    const callsBefore = mockBackend.calls.length;

    // 4. Dispatch planner2_batch directly (cohort 3 wires plan.approved → this)
    const dispatcher = createDispatcher({
      db,
      backends: { kbbl_chat: mockBackend },
      kbblUrl: "http://localhost:8788",
    });
    const sessionRef = await dispatcher.dispatch("planner2_batch", plan.id);

    // 5. Assert exactly one new MockBackend call
    expect(mockBackend.calls).toHaveLength(callsBefore + 1);
    const call = mockBackend.calls[callsBefore];
    expect(call).toBeDefined();
    if (!call) throw new Error("expected planner2_batch dispatch call");
    expect(call.stageName).toBe("planner2_batch");
    expect(call.inputType).toBe("plan");
    expect(call.inputId).toBe(plan.id);

    // 6. Assert cohorts appear in toposorted order in the rendered prompt
    // Toposort: A (in-degree 0, pos 1) → process A, B in-degree→0 (pos 2), C (in-degree 0, pos 3)
    // Queue after A: [B pos 2, C pos 3] → B before C → order: A, B, C
    const prompt = call.renderedPrompt;
    const posA = prompt.indexOf("Cohort A");
    const posB = prompt.indexOf("Cohort B");
    const posC = prompt.indexOf("Cohort C");
    expect(posA).toBeGreaterThan(-1);
    expect(posB).toBeGreaterThan(-1);
    expect(posC).toBeGreaterThan(-1);
    expect(posA).toBeLessThan(posB);
    expect(posB).toBeLessThan(posC);

    // 7. Assert dependency edge rendered in prompt
    expect(prompt).toContain("Cohort A → Cohort B");

    // 8. Assert plans.current_session_ref + current_session_stage persisted
    const planRow = db
      .prepare<{ current_session_ref: string | null; current_session_stage: string | null }, [string]>(
        "SELECT current_session_ref, current_session_stage FROM plans WHERE id = ?",
      )
      .get(plan.id);
    expect(planRow).not.toBeNull();
    if (!planRow) throw new Error("expected plan row after planner2_batch dispatch");
    expect(planRow.current_session_ref).toBe(sessionRef);
    expect(planRow.current_session_stage).toBe("planner2_batch");
  });

  test("POST /briefs/:id/build returns 404 for unknown brief", async () => {
    const res = await post(app, "/briefs/nonexistent/build", {});
    expect(res.status).toBe(404);
  });

  test("POST /briefs/:id/build returns 409 if brief not approved", async () => {
    const projRes = await post(app, "/projects", { name: "p", repo_path: "/tmp/p" });
    const proj = (await projRes.json()) as { id: string };
    const specRes = await post(app, "/specs", { project_id: proj.id, title: "s" });
    const spec = (await specRes.json()) as { id: string };
    const planRes = await post(app, "/plans", { spec_id: spec.id });
    const plan = (await planRes.json()) as { id: string };
    const cohortRes = await post(app, "/cohorts", { plan_id: plan.id, title: "C", position: 1 });
    const cohort = (await cohortRes.json()) as { id: string };
    db.prepare("UPDATE cohorts SET status = 'briefing' WHERE id = ?").run(cohort.id);
    const briefRes = await post(app, "/briefs", {
      cohort_id: cohort.id,
      goal: "g",
      files_in_scope: [],
      decisions_made: [],
      approaches_rejected: [],
      next_action: "n",
    });
    const brief = (await briefRes.json()) as { id: string };
    // brief is pending_approval, not approved
    const res = await post(app, `/briefs/${brief.id}/build`, {});
    expect(res.status).toBe(409);
  });
});
