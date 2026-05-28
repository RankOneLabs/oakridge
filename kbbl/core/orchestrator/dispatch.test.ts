/**
 * End-to-end integration test with a MockBackend.
 *
 * Drives the full lifecycle: POST /specs → spec_analyzer dispatch →
 * plan + cohorts → plan approval → brief_writer dispatch → brief → brief
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
import { mountAssessmentsRoutes } from "../server/handlers/assessments";

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
    join(promptsDir, "spec_analyzer.md"),
    "spec_analyzer {{SPEC_ID}} {{SPEC_TITLE}} {{SPEC_NOTES}} {{REPO_PATH}} {{KBBL_URL}}",
    "utf8",
  );
  writeFileSync(
    join(promptsDir, "plan_writer.md"),
    "plan_writer {{SPEC_ID}} {{SPEC_TITLE}} {{SPEC_NOTES}} {{REPO_PATH}} {{KBBL_URL}}",
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
    join(promptsDir, "brief_writer.md"),
    "brief_writer {{PLAN_ID}} {{PLAN_TITLE}} {{SPEC_NOTES}} {{COHORTS}} {{PLAN_DEPENDENCIES}} {{KBBL_URL}} {{BRIEF_FORMAT_GUIDE}}",
    "utf8",
  );
  writeFileSync(
    join(promptsDir, "planner3.md"),
    "planner3 {{PLAN_ID}} {{PLAN_TITLE}} {{SPEC_NOTES}} {{COHORT_RESULTS}} {{KBBL_URL}}",
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
  cleanupHooks = wireDispatchHooks({ taskTrackerEvents, dispatcher, db });

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
  mountAssessmentsRoutes(app, { db });
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
  test("POST /specs → spec_analyzer dispatch → plan → cohorts → plan approved → brief_writer dispatch → brief → brief approved → build dispatch → debrief PATCH", async () => {
    // 1. Create project + spec
    const projRes = await post(app, "/projects", { name: "test", repo_path: "/tmp/test-repo" });
    expect(projRes.status).toBe(201);
    const proj = (await projRes.json()) as { id: string };

    const specRes = await post(app, "/specs", { project_id: proj.id, title: "My spec", notes: "build X" });
    expect(specRes.status).toBe(201);
    const spec = (await specRes.json()) as { id: string };

    // spec.created fires → dispatch hook triggers spec_analyzer (async)
    await flushAsync();
    expect(mockBackend.calls).toHaveLength(1);
    expect(mockBackend.calls[0]!.stageName).toBe("spec_analyzer");
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

    // 3. Approve plan → plan.approved → brief_writer dispatch; all waiting cohorts → briefing
    const approveRes = await patch(app, `/plans/${plan.id}/status`, { status: "approved" });
    expect(approveRes.status).toBe(200);

    await flushAsync();
    expect(mockBackend.calls).toHaveLength(2);
    expect(mockBackend.calls[1]!.stageName).toBe("brief_writer");
    expect(mockBackend.calls[1]!.inputId).toBe(plan.id);

    // all waiting cohorts should have transitioned directly to briefing
    const cohortAfterPlanned = db.prepare<{ status: string }, [string]>("SELECT status FROM cohorts WHERE id = ?").get(cohort.id);
    expect(cohortAfterPlanned!.status).toBe("briefing");

    // current_session_ref written onto plan (brief_writer stores on plan, not cohort)
    const planRefRow = db.prepare<{ current_session_ref: string | null }, [string]>("SELECT current_session_ref FROM plans WHERE id = ?").get(plan.id);
    expect(planRefRow!.current_session_ref).toBe("mock-2");

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

    // 5. Approve brief → deps met (no deps) → cohort.build_ready → build dispatch
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

  test("dispatcher.dispatch('brief_writer', plan_id) — toposorted prompt, plan persistence", async () => {
    // 1. Create project + spec + plan
    const projRes = await post(app, "/projects", { name: "batch-test", repo_path: "/tmp/batch-repo" });
    const proj = (await projRes.json()) as { id: string };

    const specRes = await post(app, "/specs", { project_id: proj.id, title: "Batch Spec", notes: "batch notes" });
    const spec = (await specRes.json()) as { id: string };
    await flushAsync(); // spec_analyzer fires — consume that call

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

    // 4. Dispatch brief_writer directly (cohort 3 wires plan.approved → this)
    const dispatcher = createDispatcher({
      db,
      backends: { kbbl_chat: mockBackend },
      kbblUrl: "http://localhost:8788",
    });
    const sessionRef = await dispatcher.dispatch("brief_writer", plan.id);

    // 5. Assert exactly one new MockBackend call
    expect(mockBackend.calls).toHaveLength(callsBefore + 1);
    const call = mockBackend.calls[callsBefore];
    expect(call).toBeDefined();
    if (!call) throw new Error("expected brief_writer dispatch call");
    expect(call.stageName).toBe("brief_writer");
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
    if (!planRow) throw new Error("expected plan row after brief_writer dispatch");
    expect(planRow.current_session_ref).toBe(sessionRef);
    expect(planRow.current_session_stage).toBe("brief_writer");
  });

  test("plan-approved fan-out -> brief_writer -> dep-aware brief approval -> ready_to_build advancement", async () => {
    // 1. Create project + spec + plan
    const projRes = await post(app, "/projects", { name: "fanout-test", repo_path: "/tmp/fanout-repo" });
    const proj = (await projRes.json()) as { id: string };

    const specRes = await post(app, "/specs", { project_id: proj.id, title: "Fanout Spec", notes: "dep chain" });
    const spec = (await specRes.json()) as { id: string };
    await flushAsync(); // spec_analyzer fires — consume

    const planRes = await post(app, "/plans", { spec_id: spec.id });
    const plan = (await planRes.json()) as { id: string };

    // 2. Create 3 cohorts: A → B → C
    const cohortARes = await post(app, "/cohorts", { plan_id: plan.id, title: "Cohort A", position: 1 });
    const cohortA = (await cohortARes.json()) as { id: string };
    const cohortBRes = await post(app, "/cohorts", { plan_id: plan.id, title: "Cohort B", position: 2 });
    const cohortB = (await cohortBRes.json()) as { id: string };
    const cohortCRes = await post(app, "/cohorts", { plan_id: plan.id, title: "Cohort C", position: 3 });
    const cohortC = (await cohortCRes.json()) as { id: string };

    // 3. Wire deps: A→B, B→C
    expect((await post(app, "/cohort-dependencies", { from_cohort_id: cohortA.id, to_cohort_id: cohortB.id })).status).toBe(201);
    expect((await post(app, "/cohort-dependencies", { from_cohort_id: cohortB.id, to_cohort_id: cohortC.id })).status).toBe(201);

    const callsBefore = mockBackend.calls.length;

    // 4. Approve plan → plan.approved → exactly ONE brief_writer call for the whole plan
    const approveRes = await patch(app, `/plans/${plan.id}/status`, { status: "approved" });
    expect(approveRes.status).toBe(200);
    await flushAsync();

    expect(mockBackend.calls.length).toBe(callsBefore + 1);
    expect(mockBackend.calls[callsBefore]!.stageName).toBe("brief_writer");

    // all three cohorts should be briefing
    for (const id of [cohortA.id, cohortB.id, cohortC.id]) {
      expect(db.prepare<{ status: string }, [string]>("SELECT status FROM cohorts WHERE id = ?").get(id)!.status).toBe("briefing");
    }

    // 5. Post briefs for A, B, C — each should enter brief_review
    const postBrief = async (cohort_id: string) => {
      const r = await post(app, "/briefs", {
        cohort_id,
        goal: "do it",
        files_in_scope: [],
        decisions_made: [],
        approaches_rejected: [],
        next_action: "start",
      });
      expect(r.status).toBe(201);
      const b = (await r.json()) as { id: string };
      expect(db.prepare<{ status: string }, [string]>("SELECT status FROM cohorts WHERE id = ?").get(cohort_id)!.status).toBe("brief_review");
      return b.id;
    };
    const bA = await postBrief(cohortA.id);
    const bB = await postBrief(cohortB.id);
    const bC = await postBrief(cohortC.id);

    // 6. Approve briefs in order A → B → C.
    //    bA: A has no deps → building + build dispatch.
    //    bB: B depends on A (building, not done) → ready_to_build (no build dispatch).
    //    bC: C depends on B (ready_to_build, not done) → ready_to_build (no build dispatch).
    const approveA = await patch(app, `/briefs/${bA}/status`, { status: "approved" });
    expect(approveA.status).toBe(200);
    await flushAsync();
    expect(db.prepare<{ status: string }, [string]>("SELECT status FROM cohorts WHERE id = ?").get(cohortA.id)!.status).toBe("building");

    const approveB = await patch(app, `/briefs/${bB}/status`, { status: "approved" });
    expect(approveB.status).toBe(200);
    await flushAsync();

    const approveC = await patch(app, `/briefs/${bC}/status`, { status: "approved" });
    expect(approveC.status).toBe(200);
    await flushAsync();

    // After all three approved: A building, B and C ready_to_build
    expect(db.prepare<{ status: string }, [string]>("SELECT status FROM cohorts WHERE id = ?").get(cohortB.id)!.status).toBe("ready_to_build");
    expect(db.prepare<{ status: string }, [string]>("SELECT status FROM cohorts WHERE id = ?").get(cohortC.id)!.status).toBe("ready_to_build");

    // one build call for A only (B and C deferred)
    const callsAfterA = mockBackend.calls.length;
    const buildCallA = mockBackend.calls[callsAfterA - 1];
    expect(buildCallA).toBeDefined();
    expect(buildCallA?.stageName).toBe("build");
    expect(buildCallA?.inputId).toBe(bA);

    // 7. Drive A to done → B's last dep met → B enters building; C still ready_to_build
    const doneA = await patch(app, `/cohorts/${cohortA.id}/status`, { status: "done" });
    expect(doneA.status).toBe(200);
    await flushAsync();

    expect(db.prepare<{ status: string }, [string]>("SELECT status FROM cohorts WHERE id = ?").get(cohortB.id)?.status).toBe("building");
    expect(db.prepare<{ status: string }, [string]>("SELECT status FROM cohorts WHERE id = ?").get(cohortC.id)?.status).toBe("ready_to_build");

    const callsAfterADone = mockBackend.calls.length;
    expect(callsAfterADone).toBe(callsAfterA + 1);
    const buildCallB = mockBackend.calls[callsAfterA];
    expect(buildCallB).toBeDefined();
    expect(buildCallB?.stageName).toBe("build");
    expect(buildCallB?.inputId).toBe(bB);

    // 8. Drive B to done → C's last dep met → C enters building
    const doneB = await patch(app, `/cohorts/${cohortB.id}/status`, { status: "done" });
    expect(doneB.status).toBe(200);
    await flushAsync();

    expect(db.prepare<{ status: string }, [string]>("SELECT status FROM cohorts WHERE id = ?").get(cohortC.id)?.status).toBe("building");

    const callsAfterBDone = mockBackend.calls.length;
    expect(callsAfterBDone).toBe(callsAfterADone + 1);
    const buildCallC = mockBackend.calls[callsAfterADone];
    expect(buildCallC).toBeDefined();
    expect(buildCallC?.stageName).toBe("build");
    expect(buildCallC?.inputId).toBe(bC);
  });

  test("POST /briefs/:id/build returns 404 for unknown brief", async () => {
    const res = await post(app, "/briefs/nonexistent/build", {});
    expect(res.status).toBe(404);
  });

  test("plan.completed → planner3 dispatch after all cohorts go through awaiting_merge → merged", async () => {
    // 1. Create project + spec + plan
    const projRes = await post(app, "/projects", { name: "planner3-test", repo_path: "/tmp/p3-repo" });
    const proj = (await projRes.json()) as { id: string };

    const specRes = await post(app, "/specs", { project_id: proj.id, title: "P3 Spec", notes: "assess me" });
    const spec = (await specRes.json()) as { id: string };
    await flushAsync(); // spec_analyzer fires — consume

    const planRes = await post(app, "/plans", { spec_id: spec.id });
    const plan = (await planRes.json()) as { id: string };

    // 2. Create 3 cohorts: A → B → C
    const cohortARes = await post(app, "/cohorts", { plan_id: plan.id, title: "P3-Cohort-A", position: 1 });
    const cohortA = (await cohortARes.json()) as { id: string };
    const cohortBRes = await post(app, "/cohorts", { plan_id: plan.id, title: "P3-Cohort-B", position: 2 });
    const cohortB = (await cohortBRes.json()) as { id: string };
    const cohortCRes = await post(app, "/cohorts", { plan_id: plan.id, title: "P3-Cohort-C", position: 3 });
    const cohortC = (await cohortCRes.json()) as { id: string };

    // 3. Wire deps: A→B, B→C
    await post(app, "/cohort-dependencies", { from_cohort_id: cohortA.id, to_cohort_id: cohortB.id });
    await post(app, "/cohort-dependencies", { from_cohort_id: cohortB.id, to_cohort_id: cohortC.id });

    // 4. Approve plan → brief_writer
    await patch(app, `/plans/${plan.id}/status`, { status: "approved" });
    await flushAsync();

    // 5. Post and approve briefs for A, B, C (they're all in briefing status)
    const postBrief = async (cohort_id: string) => {
      const r = await post(app, "/briefs", {
        cohort_id,
        goal: "do it",
        files_in_scope: [],
        decisions_made: [],
        approaches_rejected: [],
        next_action: "start",
      });
      const b = (await r.json()) as { id: string };
      await patch(app, `/briefs/${b.id}/status`, { status: "approved" });
      await flushAsync();
      return b.id;
    };
    const bA = await postBrief(cohortA.id);
    await postBrief(cohortB.id);
    await postBrief(cohortC.id);

    // A has no deps → enters building after brief approval; B + C are ready_to_build
    const callsBeforeMerge = mockBackend.calls.length;

    // 6. Walk A through awaiting_merge → merged → B enters building
    await patch(app, `/cohorts/${cohortA.id}/status`, { status: "awaiting_merge", pr_url: "https://github.com/org/repo/pull/1" });
    await flushAsync();
    // plan.completed must NOT fire yet (B and C not done)
    const callsAfterAMerge = mockBackend.calls.length;
    expect(callsAfterAMerge).toBe(callsBeforeMerge); // no new dispatch yet

    await patch(app, `/cohorts/${cohortA.id}/status`, { status: "merged" });
    await flushAsync();
    // B should now be building; one new build dispatch for B
    const callsAfterAMerged = mockBackend.calls.length;
    expect(callsAfterAMerged).toBe(callsBeforeMerge + 1);
    expect(mockBackend.calls[callsBeforeMerge]!.stageName).toBe("build");

    // 7. Walk B through awaiting_merge → merged → C enters building
    await patch(app, `/cohorts/${cohortB.id}/status`, { status: "awaiting_merge", pr_url: "https://github.com/org/repo/pull/2" });
    await flushAsync();
    await patch(app, `/cohorts/${cohortB.id}/status`, { status: "merged" });
    await flushAsync();
    const callsAfterBMerged = mockBackend.calls.length;
    expect(callsAfterBMerged).toBe(callsBeforeMerge + 2);

    // 8. Walk C through awaiting_merge → merged → plan.completed → planner3
    await patch(app, `/cohorts/${cohortC.id}/status`, { status: "awaiting_merge", pr_url: "https://github.com/org/repo/pull/3" });
    await flushAsync();
    await patch(app, `/cohorts/${cohortC.id}/status`, { status: "merged" });
    await flushAsync();

    // Exactly one new call: planner3
    const callsAfterCMerged = mockBackend.calls.length;
    expect(callsAfterCMerged).toBe(callsBeforeMerge + 3);
    const planner3Call = mockBackend.calls[callsBeforeMerge + 2];
    expect(planner3Call).toBeDefined();
    expect(planner3Call!.stageName).toBe("planner3");
    expect(planner3Call!.inputType).toBe("plan");
    expect(planner3Call!.inputId).toBe(plan.id);

    // plans.current_session_stage === 'planner3' and current_session_ref persisted
    const planRow = db
      .prepare<{ current_session_ref: string | null; current_session_stage: string | null }, [string]>(
        "SELECT current_session_ref, current_session_stage FROM plans WHERE id = ?",
      )
      .get(plan.id);
    expect(planRow!.current_session_stage).toBe("planner3");
    expect(planRow!.current_session_ref).toBeDefined();
    expect(planRow!.current_session_ref).not.toBeNull();

    // debrief with deviations on bA — round-trip check
    const debriefRes = await patch(app, `/briefs/${bA}/debrief`, {
      debrief: "Built A.",
      deviations: [{ from: "file.ts", actual: "other.ts", downstream_impact: "minor" }],
    });
    expect(debriefRes.status).toBe(200);
    const debriefed = (await debriefRes.json()) as { deviations: unknown };
    expect(Array.isArray(debriefed.deviations)).toBe(true);
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

