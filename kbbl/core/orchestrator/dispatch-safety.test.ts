/**
 * Dispatch safety acceptance tests.
 *
 * Covers the six scenarios the durable dispatch_attempts model is designed to
 * prevent or survive:
 *
 *  1. Restart between DB state transition and session spawn → boot reconciler
 *     marks the stranded attempt dispatch_failed.
 *  2. Double build POST → second request returns 409 with the active attempt id.
 *  3. Hook-vs-click race → only one succeeds; the other gets a DispatchConflictError.
 *  4. Failed dispatch cleanup → attempt marked dispatch_failed, claim cleared,
 *     next call can claim successfully.
 *  5. Second build attempt → new attempt linked to the failed predecessor with
 *     attempt_number incremented and branch / worktree names carry attempt-002.
 *  6. Second assessor attempt → same retry traceability for plan/assessor stage.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { openTestDb } from "../db/test-db";
import { reviewRegistry } from "../review/registry";
import { reviewEvents } from "../review/events";
import { taskTrackerEvents } from "../db/events";
import { bootstrap } from "./bootstrap";
import { createDispatcher, DispatchConflictError } from "./backends/dispatcher";
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
import { mountSpecStatusRoutes } from "../server/handlers/spec-status";
import {
  claimDispatch,
  markAttemptFailed,
  markAttemptRunning,
  getActiveAttempt,
  listActiveAttempts,
  getAttempt,
  formatAttemptSuffix,
} from "../db/dispatch-attempts";
import { reconcileDispatchAttempts } from "./dispatch-reconciler";
import { insertProject } from "../db/projects";
import { insertSpec } from "../db/specs";
import { insertEpic } from "../db/epics";
import { insertPlan } from "../db/plans";
import { insertCohort } from "../db/cohorts";
import { insertBrief } from "../db/briefs";
import type { SessionManager } from "../session/session-manager";
import type { RuntimeModelSelection } from "../runtime";

// ---- stub manager ----

const stubManager = {
  get: (_sid: string) => undefined,
} as unknown as SessionManager;

// ---- MockBackend ----

type DispatchResult = { session_ref: string };
type DispatchFn = (stage: StageRow, inputRef: InputRef, renderedPrompt: string) => Promise<DispatchResult>;

type StatusFn = (ref: string) => Promise<"running" | "completed" | "failed">;

function createMockBackend(dispatchFn?: DispatchFn, statusFn?: StatusFn): ExecutionBackend & { calls: number } {
  let calls = 0;
  return {
    id: "kbbl_chat",
    get calls() { return calls; },
    async dispatch(stage: StageRow, inputRef: InputRef, renderedPrompt: string) {
      calls++;
      if (dispatchFn) return dispatchFn(stage, inputRef, renderedPrompt);
      return { session_ref: `mock-${calls}` };
    },
    async status(session_ref: string) {
      if (statusFn) return statusFn(session_ref);
      return "completed" as const;
    },
  };
}

// ---- git repo for ensureEpicBranchExists ----

let gitTmpRoot: string;
let testRepoPath: string;

async function runCmd(cmd: string[]): Promise<void> {
  const p = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (exit ${code}): ${stderr}`);
}

beforeAll(async () => {
  gitTmpRoot = mkdtempSync(join(tmpdir(), "kbbl-safety-git-"));
  const originPath = join(gitTmpRoot, "origin");
  testRepoPath = join(gitTmpRoot, "workdir");
  await runCmd(["git", "init", "--bare", "-b", "main", originPath]);
  await runCmd(["git", "clone", originPath, testRepoPath]);
  await runCmd(["git", "-C", testRepoPath, "config", "user.email", "test@example.com"]);
  await runCmd(["git", "-C", testRepoPath, "config", "user.name", "test"]);
  await runCmd(["git", "-C", testRepoPath, "config", "commit.gpgsign", "false"]);
  await runCmd(["git", "-C", testRepoPath, "commit", "--allow-empty", "-m", "init"]);
  await runCmd(["git", "-C", testRepoPath, "push", "origin", "main"]);
});

afterAll(() => {
  rmSync(gitTmpRoot, { recursive: true, force: true });
});

// ---- prompt fixtures ----

let promptsDir: string;
const origPromptsDir = process.env.KBBL_PROMPTS_DIR;

function setupPromptFixtures() {
  promptsDir = mkdtempSync(join(tmpdir(), "kbbl-safety-prompts-"));
  writeFileSync(join(promptsDir, "spec_analyzer.md"),
    "spec_analyzer {{SPEC_ID}} {{SPEC_TITLE}} {{SPEC_NOTES}} {{REPO_PATH}} {{KBBL_URL}}", "utf8");
  writeFileSync(join(promptsDir, "plan_writer.md"),
    "plan_writer {{SPEC_ID}} {{SPEC_TITLE}} {{SPEC_NOTES}} {{DISCREPANCY_RESOLUTIONS}} {{REPO_PATH}} {{KBBL_URL}}", "utf8");
  writeFileSync(join(promptsDir, "brief_writer.md"),
    "brief_writer {{PLAN_ID}} {{PLAN_TITLE}} {{SPEC_NOTES}} {{COHORTS}} {{PLAN_DEPENDENCIES}} {{KBBL_URL}} {{BRIEF_FORMAT_GUIDE}}", "utf8");
  writeFileSync(join(promptsDir, "build.md"),
    "build {{BRIEF_ID}} {{BRIEF_RENDERED}} {{REPO_PATH}} {{KBBL_URL}}", "utf8");
  writeFileSync(join(promptsDir, "assessor.md"),
    "assessor {{PLAN_ID}} {{PLAN_TITLE}} {{SPEC_NOTES}} {{COHORT_RESULTS}} {{KBBL_URL}} {{EPIC_BRANCH}}", "utf8");
  process.env.KBBL_PROMPTS_DIR = promptsDir;
}

// ---- per-test fixtures ----

let db: Database;
let cleanupBootstrap: () => void;
let cleanupHooks: (() => void) | undefined;

const MODEL_SEL: RuntimeModelSelection = { runtime: "claude-code", model: "claude-sonnet-4-6" };
const PLANNER_SEL: RuntimeModelSelection = { runtime: "claude-code", model: "claude-opus-4-8" };

function makeApp(backend: ExecutionBackend) {
  const dispatcher = createDispatcher({
    db,
    backends: { kbbl_chat: backend },
    kbblUrl: "http://localhost:8788",
  });
  cleanupHooks = wireDispatchHooks({ taskTrackerEvents, dispatcher, db });

  const a = new Hono();
  mountProjectsRoutes(a, { db });
  mountSpecsRoutes(a, { db });
  mountPlansRoutes(a, { db });
  mountPlanStatusRoutes(a, { db });
  mountPlanReopenRoutes(a, { db });
  mountCohortsRoutes(a, { db, manager: stubManager });
  mountCohortStatusRoutes(a, { db });
  mountBriefsRoutes(a, { db });
  mountBriefStatusRoutes(a, { db });
  mountBuildsRoutes(a, { db, dispatcher, manager: stubManager });
  mountAssessmentsRoutes(a, { db });
  mountSpecStatusRoutes(a, { db });
  return { app: a, dispatcher };
}

/** Insert a minimal project→spec→epic→plan→cohort→brief chain and return their ids. */
async function seedBuildChain(repoPath = testRepoPath) {
  const proj = insertProject(db, { id: crypto.randomUUID(), name: "p", repo_path: repoPath });
  const spec = insertSpec(db, { id: crypto.randomUUID(), project_id: proj.id, title: "S" });
  insertEpic(db, {
    id: crypto.randomUUID(), spec_id: spec.id, project_id: proj.id, title: "E",
    status: "active", current_stage: "build",
    planner_model_selection: PLANNER_SEL,
    worker_model_selection: MODEL_SEL,
  });
  const plan = insertPlan(db, { id: crypto.randomUUID(), spec_id: spec.id });
  const cohort = insertCohort(db, { id: crypto.randomUUID(), plan_id: plan.id, title: "C", position: 1 });
  db.prepare("UPDATE cohorts SET status = 'briefing' WHERE id = ?").run(cohort.id);
  const brief = insertBrief(db, {
    id: crypto.randomUUID(), cohort_id: cohort.id, goal: "g",
    files_in_scope: [], decisions_made: [], approaches_rejected: [], next_action: "n",
  });
  db.prepare("UPDATE briefs SET status = 'approved' WHERE id = ?").run(brief.id);
  return { proj, spec, plan, cohort, brief };
}

beforeEach(() => {
  setupPromptFixtures();
  db = openTestDb();
  cleanupBootstrap = bootstrap({ db, registry: reviewRegistry, reviewEvents, taskTrackerEvents });
});

afterEach(() => {
  cleanupHooks?.();
  cleanupBootstrap();
  db.close();
  if (origPromptsDir === undefined) {
    delete process.env.KBBL_PROMPTS_DIR;
  } else {
    process.env.KBBL_PROMPTS_DIR = origPromptsDir;
  }
  rmSync(promptsDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Restart between DB state transition and session spawn
// ---------------------------------------------------------------------------

describe("1. Boot reconciliation — stranded dispatching attempts", () => {
  test("dispatching attempt with no session ref is marked dispatch_failed at boot", async () => {
    const { brief, cohort } = await seedBuildChain();

    // Simulate a crash between DB write and session spawn: insert an attempt
    // in 'dispatching' status but do NOT spawn a session or set actual_session_ref.
    const r = claimDispatch(db, {
      id: crypto.randomUUID(),
      entity_kind: "brief",
      entity_id: brief.id,
      stage: "build",
      cohort_id: cohort.id,
    });
    expect(r.claimed).toBe(true);
    if (!r.claimed) throw new Error("expected claim");
    const attempt = r.attempt;
    expect(attempt.status).toBe("dispatching");
    expect(attempt.actual_session_ref).toBeNull();

    // Confirm the active claim is visible.
    expect(getActiveAttempt(db, "brief", brief.id, "build")).not.toBeNull();

    // Simulate server restart: run boot reconciliation with an empty manager
    // (no live sessions survive a process restart).
    reconcileDispatchAttempts(db, stubManager);

    // The stranded dispatching attempt must become dispatch_failed so the
    // active-claim slot is freed and the operator has a recovery path.
    const afterRecon = getAttempt(db, attempt.id)!;
    expect(afterRecon.status).toBe("dispatch_failed");
    expect(afterRecon.last_error).toContain("spawn_not_observed_after_restart");
    expect(afterRecon.recovery_hint).toBeTruthy();

    // Active claim is now clear — a new dispatch can claim the slot.
    expect(getActiveAttempt(db, "brief", brief.id, "build")).toBeNull();
  });

  test("running attempt whose session is not in the manager is marked dispatch_failed at boot", async () => {
    const { brief, cohort } = await seedBuildChain();

    const r = claimDispatch(db, {
      id: crypto.randomUUID(),
      entity_kind: "brief",
      entity_id: brief.id,
      stage: "build",
      cohort_id: cohort.id,
    });
    expect(r.claimed).toBe(true);
    if (!r.claimed) throw new Error("expected claim");

    // Simulate a crash after session spawn but before the process could update
    // the attempt: the attempt is marked running (session was handed off) but
    // the session is not in the post-restart manager.
    markAttemptRunning(db, r.attempt.id, "ghost-session-ref");

    reconcileDispatchAttempts(db, stubManager);

    const afterRecon = getAttempt(db, r.attempt.id)!;
    expect(afterRecon.status).toBe("dispatch_failed");
    expect(afterRecon.last_error).toContain("ghost-session-ref");

    expect(getActiveAttempt(db, "brief", brief.id, "build")).toBeNull();
  });

  test("reconciliation is a no-op when there are no active attempts", () => {
    // Fresh DB — nothing to reconcile, should not throw.
    expect(() => reconcileDispatchAttempts(db, stubManager)).not.toThrow();
    expect(listActiveAttempts(db)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Double build POST
// ---------------------------------------------------------------------------

describe("2. Double build POST", () => {
  test("second POST /briefs/:id/build returns 409 with active_attempt_id while first is dispatching", async () => {
    const { brief } = await seedBuildChain();

    // Occupy the dispatch slot manually (simulating first request in flight).
    const r = claimDispatch(db, {
      id: crypto.randomUUID(),
      entity_kind: "brief",
      entity_id: brief.id,
      stage: "build",
      cohort_id: brief.cohort_id,
    });
    expect(r.claimed).toBe(true);
    if (!r.claimed) throw new Error("expected claim");
    const activeAttemptId = r.attempt.id;

    // Second POST must bounce.
    const backend = createMockBackend();
    const { app: a } = makeApp(backend);
    const res = await a.request(`/briefs/${brief.id}/build`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { active_attempt_id?: string; status?: string };
    expect(body.active_attempt_id).toBe(activeAttemptId);
    expect(body.status).toBe("dispatching");

    // Backend must NOT have been called.
    expect(backend.calls).toBe(0);
  });

  test("second POST /briefs/:id/build returns 409 with session_ref when first attempt is running", async () => {
    const { brief } = await seedBuildChain();

    const r = claimDispatch(db, {
      id: crypto.randomUUID(),
      entity_kind: "brief",
      entity_id: brief.id,
      stage: "build",
      cohort_id: brief.cohort_id,
    });
    expect(r.claimed).toBe(true);
    if (!r.claimed) throw new Error("expected claim");
    markAttemptRunning(db, r.attempt.id, "active-session-ref-42");

    // The status function must report the active session as still running so the
    // lazy-close in dispatcher does not prematurely close the claim.
    const backend = createMockBackend(undefined, async (ref) =>
      ref === "active-session-ref-42" ? "running" : "completed",
    );
    const { app: a } = makeApp(backend);
    const res = await a.request(`/briefs/${brief.id}/build`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { active_attempt_id?: string; current_session_ref?: string; status?: string };
    expect(body.active_attempt_id).toBe(r.attempt.id);
    expect(body.current_session_ref).toBe("active-session-ref-42");
    expect(body.status).toBe("running");
    expect(backend.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Hook-vs-click race
// ---------------------------------------------------------------------------

describe("3. Hook-vs-click race", () => {
  test("concurrent dispatches for the same brief: exactly one wins, the other throws DispatchConflictError", async () => {
    const { brief } = await seedBuildChain();

    let conflictCount = 0;
    let successCount = 0;

    // Run two dispatcher.dispatch calls concurrently for the same brief.
    const backend = createMockBackend();
    const dispatcher = createDispatcher({
      db,
      backends: { kbbl_chat: backend },
      kbblUrl: "http://localhost:8788",
    });
    cleanupHooks = () => {};

    await Promise.allSettled([
      dispatcher.dispatch("build", brief.id).then(() => { successCount++; }).catch((err: unknown) => {
        if (err instanceof DispatchConflictError) conflictCount++;
        else throw err;
      }),
      dispatcher.dispatch("build", brief.id).then(() => { successCount++; }).catch((err: unknown) => {
        if (err instanceof DispatchConflictError) conflictCount++;
        else throw err;
      }),
    ]);

    // Exactly one succeeds and one conflicts.
    expect(successCount).toBe(1);
    expect(conflictCount).toBe(1);
    expect(backend.calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Failed dispatch cleanup
// ---------------------------------------------------------------------------

describe("4. Failed dispatch cleanup", () => {
  test("spawn failure marks attempt dispatch_failed and clears the claim", async () => {
    const { brief } = await seedBuildChain();

    const throwingBackend: ExecutionBackend = {
      id: "kbbl_chat",
      async dispatch() { throw new Error("simulated spawn failure"); },
      async status() { return "failed"; },
    };

    const dispatcher = createDispatcher({
      db,
      backends: { kbbl_chat: throwingBackend },
      kbblUrl: "http://localhost:8788",
    });
    cleanupHooks = () => {};

    await expect(dispatcher.dispatch("build", brief.id)).rejects.toThrow("simulated spawn failure");

    // Claim must be cleared — no active attempt remains.
    expect(getActiveAttempt(db, "brief", brief.id, "build")).toBeNull();

    // The failed attempt is queryable and has error metadata.
    const attempts = db
      .prepare<{ status: string; last_error: string | null }, []>(
        "SELECT status, last_error FROM dispatch_attempts WHERE stage = 'build' ORDER BY attempt_number",
      )
      .all();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe("dispatch_failed");
    expect(attempts[0]!.last_error).toContain("simulated spawn failure");
  });

  test("git failure (ensureEpicBranchExists) marks attempt dispatch_failed", async () => {
    // Use a non-existent workdir so git commands fail.
    const { brief } = await seedBuildChain("/nonexistent/repo");

    const backend = createMockBackend();
    const dispatcher = createDispatcher({
      db,
      backends: { kbbl_chat: backend },
      kbblUrl: "http://localhost:8788",
    });
    cleanupHooks = () => {};

    await expect(dispatcher.dispatch("build", brief.id)).rejects.toThrow();

    expect(getActiveAttempt(db, "brief", brief.id, "build")).toBeNull();
    const row = db
      .prepare<{ status: string }, []>(
        "SELECT status FROM dispatch_attempts WHERE stage = 'build' ORDER BY attempt_number DESC LIMIT 1",
      )
      .get();
    expect(row?.status).toBe("dispatch_failed");
    // Backend must NOT have been called since git failed first.
    expect(backend.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Second build attempt — predecessor linkage and attempt-002 suffix
// ---------------------------------------------------------------------------

describe("5. Second build attempt", () => {
  test("second attempt has predecessor_attempt_id pointing to first, attempt_number increments, branch carries attempt-002", async () => {
    const { brief } = await seedBuildChain();

    // First attempt: claim and mark failed.
    const r1 = claimDispatch(db, {
      id: crypto.randomUUID(),
      entity_kind: "brief",
      entity_id: brief.id,
      stage: "build",
      cohort_id: brief.cohort_id,
    });
    expect(r1.claimed).toBe(true);
    if (!r1.claimed) throw new Error();
    markAttemptFailed(db, r1.attempt.id, { last_error: "first attempt failed" });

    expect(r1.attempt.attempt_number).toBe(1);
    expect(getActiveAttempt(db, "brief", brief.id, "build")).toBeNull();

    // Second attempt: fresh claim, linked to first.
    const r2 = claimDispatch(db, {
      id: crypto.randomUUID(),
      entity_kind: "brief",
      entity_id: brief.id,
      stage: "build",
      cohort_id: brief.cohort_id,
    });
    expect(r2.claimed).toBe(true);
    if (!r2.claimed) throw new Error();
    const second = r2.attempt;

    expect(second.attempt_number).toBe(2);
    expect(second.predecessor_attempt_id).toBe(r1.attempt.id);
    expect(formatAttemptSuffix(second.attempt_number)).toBe("attempt-002");
  });

  test("POST /briefs/:id/build after failed dispatch spawns attempt-002 session", async () => {
    const { brief } = await seedBuildChain();

    // Pre-create a failed first attempt to simulate a prior failed build.
    const r1 = claimDispatch(db, {
      id: crypto.randomUUID(),
      entity_kind: "brief",
      entity_id: brief.id,
      stage: "build",
      cohort_id: brief.cohort_id,
    });
    expect(r1.claimed).toBe(true);
    if (!r1.claimed) throw new Error();
    markAttemptFailed(db, r1.attempt.id, { last_error: "previous attempt failed" });

    let capturedWorktreeIdentity: InputRef["worktreeIdentity"] | undefined;
    const trackingBackend: ExecutionBackend = {
      id: "kbbl_chat",
      async dispatch(_stage, inputRef) {
        capturedWorktreeIdentity = inputRef.worktreeIdentity;
        return { session_ref: "session-attempt-002" };
      },
      async status() { return "running"; },
    };

    const { app: a } = makeApp(trackingBackend);
    const res = await a.request(`/briefs/${brief.id}/build`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);

    // The worktreeIdentity must carry attempt-002.
    expect(capturedWorktreeIdentity?.attemptSuffix).toBe("attempt-002");

    // The new attempt is the second one.
    const attempts = db
      .prepare<{ attempt_number: number; status: string; predecessor_attempt_id: string | null }, []>(
        "SELECT attempt_number, status, predecessor_attempt_id FROM dispatch_attempts WHERE stage = 'build' ORDER BY attempt_number",
      )
      .all();
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.status).toBe("dispatch_failed");
    expect(attempts[1]!.attempt_number).toBe(2);
    expect(attempts[1]!.predecessor_attempt_id).toBe(r1.attempt.id);
    expect(attempts[1]!.status).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// 6. Second assessor attempt — same retry guarantees for plan/assessor
// ---------------------------------------------------------------------------

describe("6. Second assessor attempt", () => {
  test("assessor retry increments attempt_number and links predecessor", async () => {
    const proj = insertProject(db, { id: crypto.randomUUID(), name: "q", repo_path: testRepoPath });
    const spec = insertSpec(db, { id: crypto.randomUUID(), project_id: proj.id, title: "Assess Me" });
    insertEpic(db, {
      id: crypto.randomUUID(), spec_id: spec.id, project_id: proj.id, title: "AssessEpic",
      status: "active", current_stage: "assess",
      planner_model_selection: PLANNER_SEL,
      worker_model_selection: MODEL_SEL,
    });
    const plan = insertPlan(db, { id: crypto.randomUUID(), spec_id: spec.id });

    // First assessor claim → mark failed.
    const r1 = claimDispatch(db, {
      id: crypto.randomUUID(),
      entity_kind: "plan",
      entity_id: plan.id,
      stage: "assessor",
    });
    expect(r1.claimed).toBe(true);
    if (!r1.claimed) throw new Error();
    markAttemptFailed(db, r1.attempt.id, { last_error: "first assessor attempt failed" });

    expect(getActiveAttempt(db, "plan", plan.id, "assessor")).toBeNull();

    // Second assessor claim.
    const r2 = claimDispatch(db, {
      id: crypto.randomUUID(),
      entity_kind: "plan",
      entity_id: plan.id,
      stage: "assessor",
    });
    expect(r2.claimed).toBe(true);
    if (!r2.claimed) throw new Error();

    expect(r2.attempt.attempt_number).toBe(2);
    expect(r2.attempt.predecessor_attempt_id).toBe(r1.attempt.id);
    expect(formatAttemptSuffix(r2.attempt.attempt_number)).toBe("attempt-002");
  });
});

