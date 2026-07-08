import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { openTestDb } from "../../db/test-db";
import { insertProject } from "../../db/projects";
import { insertSpec } from "../../db/specs";
import { insertPlan } from "../../db/plans";
import { insertCohort, getCohort, insertCohortDependency } from "../../db/cohorts";
import { insertBrief, getBrief } from "../../db/briefs";
import { taskTrackerEvents } from "../../db/events";
import { mountCohortStatusRoutes, applyAwaitingMergeToMerged } from "./cohort-status";

const PROJECT_ID = "proj-1";
const SPEC_ID = "spec-1";
const PLAN_ID = "plan-1";
const COHORT_ID = "cohort-1";

const BRIEF_DEFAULTS = {
  goal: "ship it",
  files_in_scope: ["src/foo.ts"],
  decisions_made: [{ decision: "D", rationale: "R" }],
  approaches_rejected: [{ approach: "A", reason: "N" }],
  next_action: "go",
};

let db: Database;
let app: Hono;

function setStatus(id: string, status: string) {
  db.prepare("UPDATE cohorts SET status = ? WHERE id = ?").run(status, id);
}

function patch(id: string, body: unknown) {
  return app.request(`/cohorts/${id}/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  db = openTestDb();
  insertProject(db, { id: PROJECT_ID, name: "P", repo_path: "/p" });
  insertSpec(db, { id: SPEC_ID, project_id: PROJECT_ID, title: "S" });
  insertPlan(db, { id: PLAN_ID, spec_id: SPEC_ID });
  insertCohort(db, { id: COHORT_ID, plan_id: PLAN_ID, title: "C1", position: 1 });
  app = new Hono();
  mountCohortStatusRoutes(app, { db });
});

afterEach(() => {
  db.close();
});

describe("PATCH /cohorts/:id/status — validation", () => {
  test("invalid JSON → 400", async () => {
    const res = await app.request(`/cohorts/${COHORT_ID}/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/invalid json/);
  });

  test("unrecognized status string → 400", async () => {
    const res = await patch(COHORT_ID, { status: "bogus" });
    expect(res.status).toBe(400);
  });

  test("orchestrator-only status (planned) → 422", async () => {
    const res = await patch(COHORT_ID, { status: "planned" });
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/orchestrator-only/);
  });

  test("orchestrator-only status (briefing) → 422", async () => {
    const res = await patch(COHORT_ID, { status: "briefing" });
    expect(res.status).toBe(422);
  });

  test("orchestrator-only status (ready_to_build) → 422", async () => {
    const res = await patch(COHORT_ID, { status: "ready_to_build" });
    expect(res.status).toBe(422);
  });

  test("awaiting_merge without pr_url → 400 with validation message", async () => {
    const res = await patch(COHORT_ID, { status: "awaiting_merge" });
    expect(res.status).toBe(400);
  });

  test("awaiting_merge with non-URL pr_url → 400 with validation message", async () => {
    const res = await patch(COHORT_ID, { status: "awaiting_merge", pr_url: "not-a-url" });
    expect(res.status).toBe(400);
  });

  test("not found → 404", async () => {
    const res = await patch("nonexistent", { status: "done" });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /cohorts/:id/status — blocked / unblocked (existing paths)", () => {
  test("blocked: 200 sets status, stores pre_block_status", async () => {
    const res = await patch(COHORT_ID, { status: "blocked" });
    expect(res.status).toBe(200);
    const cohort = getCohort(db, COHORT_ID)!;
    expect(cohort.status).toBe("blocked");
    expect(cohort.pre_block_status).toBe("waiting");
  });

  test("blocked: 409 if already blocked", async () => {
    setStatus(COHORT_ID, "blocked");
    db.prepare("UPDATE cohorts SET pre_block_status = 'building' WHERE id = ?").run(COHORT_ID);
    const res = await patch(COHORT_ID, { status: "blocked" });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; current_status: string; requested: string };
    expect(body.current_status).toBe("blocked");
    expect(body.requested).toBe("blocked");
  });

  test("unblocked: 200 restores pre_block_status", async () => {
    setStatus(COHORT_ID, "blocked");
    db.prepare("UPDATE cohorts SET pre_block_status = 'building' WHERE id = ?").run(COHORT_ID);
    const res = await patch(COHORT_ID, { status: "unblocked" });
    expect(res.status).toBe(200);
    const cohort = getCohort(db, COHORT_ID)!;
    expect(cohort.status).toBe("building");
    expect(cohort.pre_block_status).toBeNull();
  });

  test("unblocked: 409 if not blocked", async () => {
    const res = await patch(COHORT_ID, { status: "unblocked" });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/not blocked/);
  });
});

describe("PATCH /cohorts/:id/status done (legacy override from building)", () => {
  test("409 if not in building status", async () => {
    // cohort starts in 'waiting'; build_completed event is not valid from 'waiting'
    const res = await patch(COHORT_ID, { status: "done" });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; current_status: string; requested: string };
    expect(body.current_status).toBe("waiting");
    expect(body.requested).toBe("done");
  });

  test("200 from building, sets status to done, emits cohort.done", async () => {
    setStatus(COHORT_ID, "building");
    const emitted: { cohort_id: string }[] = [];
    const unsub = taskTrackerEvents.subscribe("cohort.done", (p) => emitted.push(p));
    try {
      const res = await patch(COHORT_ID, { status: "done" });
      expect(res.status).toBe(200);
      expect(getCohort(db, COHORT_ID)!.status).toBe("done");
      expect(emitted).toEqual([{ cohort_id: COHORT_ID }]);
    } finally {
      unsub();
    }
  });

});

describe("PATCH /cohorts/:id/status awaiting_merge (new)", () => {
  const PR_URL = "https://github.com/org/repo/pull/42";

  test("409 if not in building status", async () => {
    // cohort starts in 'waiting'; pr_opened event is not valid from 'waiting'
    const res = await patch(COHORT_ID, { status: "awaiting_merge", pr_url: PR_URL });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; current_status: string; requested: string };
    expect(body.current_status).toBe("waiting");
    expect(body.requested).toBe("awaiting_merge");
  });

  test("200 from building, sets status to awaiting_merge", async () => {
    setStatus(COHORT_ID, "building");
    const res = await patch(COHORT_ID, { status: "awaiting_merge", pr_url: PR_URL });
    expect(res.status).toBe(200);
    expect(getCohort(db, COHORT_ID)!.status).toBe("awaiting_merge");
  });

  test("emits cohort.pr_opened with cohort_id and pr_url", async () => {
    setStatus(COHORT_ID, "building");
    const emitted: { cohort_id: string; pr_url: string }[] = [];
    const unsub = taskTrackerEvents.subscribe("cohort.pr_opened", (p) => emitted.push(p));
    try {
      await patch(COHORT_ID, { status: "awaiting_merge", pr_url: PR_URL });
      expect(emitted).toEqual([{ cohort_id: COHORT_ID, pr_url: PR_URL }]);
    } finally {
      unsub();
    }
  });

  test("COALESCE-updates pr_url on the latest brief", async () => {
    setStatus(COHORT_ID, "building");
    const brief = insertBrief(db, { id: "b1", cohort_id: COHORT_ID, ...BRIEF_DEFAULTS });
    expect(brief.pr_url).toBeNull();

    await patch(COHORT_ID, { status: "awaiting_merge", pr_url: PR_URL });

    expect(getBrief(db, "b1")!.pr_url).toBe(PR_URL);
  });

  test("COALESCE: does not overwrite already-set pr_url (step 5 debrief set it first)", async () => {
    setStatus(COHORT_ID, "building");
    insertBrief(db, { id: "b1", cohort_id: COHORT_ID, ...BRIEF_DEFAULTS });
    // Simulate step 5 debrief already populated pr_url
    db.prepare("UPDATE briefs SET pr_url = ? WHERE id = ?").run("https://github.com/org/repo/pull/1", "b1");

    // Step 6 cohort-status PATCH — COALESCE(pr_url, ?) keeps existing non-null value
    await patch(COHORT_ID, { status: "awaiting_merge", pr_url: "https://github.com/org/repo/pull/99" });

    expect(getBrief(db, "b1")!.pr_url).toBe("https://github.com/org/repo/pull/1");
  });

  test("does not emit cohort.done and does not run fan-out", async () => {
    const DEP_ID = "cohort-dep";
    insertCohort(db, { id: DEP_ID, plan_id: PLAN_ID, title: "dep", position: 2 });
    insertCohortDependency(db, { id: "d1", from_cohort_id: COHORT_ID, to_cohort_id: DEP_ID });
    setStatus(COHORT_ID, "building");

    const doneEvents: unknown[] = [];
    const unsubDone = taskTrackerEvents.subscribe("cohort.done", (p) => doneEvents.push(p));
    try {
      await patch(COHORT_ID, { status: "awaiting_merge", pr_url: PR_URL });
      expect(doneEvents).toHaveLength(0);
      expect(getCohort(db, DEP_ID)!.status).toBe("waiting");
    } finally {
      unsubDone();
    }
  });
});

describe("PATCH /cohorts/:id/status merged (new)", () => {
  test("409 if pr_merged event has no valid transition from current state", async () => {
    // 'waiting' has no pr_merged transition in the state machine
    // (note: 'building' allows pr_merged directly per state machine, so use 'waiting' to test the guard)
    const res = await patch(COHORT_ID, { status: "merged" });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; current_status: string; requested: string };
    expect(body.current_status).toBe("waiting");
    expect(body.requested).toBe("merged");
  });

  test("200 from awaiting_merge, sets status to done", async () => {
    setStatus(COHORT_ID, "awaiting_merge");
    const res = await patch(COHORT_ID, { status: "merged" });
    expect(res.status).toBe(200);
    expect(getCohort(db, COHORT_ID)!.status).toBe("done");
  });

  test("emits cohort.pr_merged and cohort.done", async () => {
    setStatus(COHORT_ID, "awaiting_merge");
    const mergedEvts: { cohort_id: string }[] = [];
    const doneEvts: { cohort_id: string }[] = [];
    const unsubMerged = taskTrackerEvents.subscribe("cohort.pr_merged", (p) => mergedEvts.push(p));
    const unsubDone = taskTrackerEvents.subscribe("cohort.done", (p) => doneEvts.push(p));
    try {
      await patch(COHORT_ID, { status: "merged" });
      expect(mergedEvts).toEqual([{ cohort_id: COHORT_ID }]);
      expect(doneEvts).toEqual([{ cohort_id: COHORT_ID }]);
    } finally {
      unsubMerged();
      unsubDone();
    }
  });

});

describe("plan.completed emission", () => {
  function flushAsync() {
    return new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  test("emits plan.completed when the last cohort transitions merged → done", async () => {
    setStatus(COHORT_ID, "awaiting_merge");
    const completed: { plan_id: string }[] = [];
    const unsub = taskTrackerEvents.subscribe("plan.completed", (p) => completed.push(p));
    try {
      await patch(COHORT_ID, { status: "merged" });
      await flushAsync();
      expect(completed).toHaveLength(1);
      expect(completed[0]!.plan_id).toBe(PLAN_ID);
    } finally {
      unsub();
    }
  });

  test("emits plan.completed from legacy direct-done path when last cohort", async () => {
    setStatus(COHORT_ID, "building");
    const completed: { plan_id: string }[] = [];
    const unsub = taskTrackerEvents.subscribe("plan.completed", (p) => completed.push(p));
    try {
      await patch(COHORT_ID, { status: "done" });
      await flushAsync();
      expect(completed).toHaveLength(1);
      expect(completed[0]!.plan_id).toBe(PLAN_ID);
    } finally {
      unsub();
    }
  });

  test("does NOT emit plan.completed when other cohorts in the plan are still building", async () => {
    const OTHER_ID = "cohort-other";
    insertCohort(db, { id: OTHER_ID, plan_id: PLAN_ID, title: "Other", position: 2 });
    setStatus(OTHER_ID, "building");
    setStatus(COHORT_ID, "awaiting_merge");

    const completed: unknown[] = [];
    const unsub = taskTrackerEvents.subscribe("plan.completed", (p) => completed.push(p));
    try {
      await patch(COHORT_ID, { status: "merged" });
      await flushAsync();
      expect(completed).toHaveLength(0);
    } finally {
      unsub();
    }
  });
});

describe("applyAwaitingMergeToMerged — shared helper smoke test", () => {
  test("transitions cohort to done and returns emits matching PATCH merged behavior", () => {
    setStatus(COHORT_ID, "awaiting_merge");
    const result = db.transaction(() => applyAwaitingMergeToMerged(db, COHORT_ID))();
    expect(getCohort(db, COHORT_ID)!.status).toBe("done");
    expect(result.updated.status).toBe("done");
    expect(result.emits).not.toBeNull();
    expect(result.emits!.done).toEqual({ cohort_id: COHORT_ID });
    expect(result.emits!.pr_merged).toEqual({ cohort_id: COHORT_ID });
    expect(result.emits!.buildReady).toEqual([]);
    expect(result.emits!.planCompleted).toEqual({ plan_id: PLAN_ID });
  });

  test("returns emits=null when cohort is already done (race no-op)", () => {
    setStatus(COHORT_ID, "done");
    const result = db.transaction(() => applyAwaitingMergeToMerged(db, COHORT_ID))();
    expect(result.updated.status).toBe("done");
    expect(result.emits).toBeNull();
  });
});

describe("merge gate integration: building → awaiting_merge → merged fan-out", () => {
  test("downstream waiting cohort stays waiting after merge (fan-out only advances ready_to_build)", async () => {
    const DEP_ID = "cohort-dep";
    insertCohort(db, { id: DEP_ID, plan_id: PLAN_ID, title: "dep", position: 2 });
    insertCohortDependency(db, { id: "d1", from_cohort_id: COHORT_ID, to_cohort_id: DEP_ID });
    setStatus(COHORT_ID, "building");

    // Step 1: build agent signals PR open — gate interposed
    await patch(COHORT_ID, { status: "awaiting_merge", pr_url: "https://github.com/org/repo/pull/7" });
    expect(getCohort(db, COHORT_ID)!.status).toBe("awaiting_merge");
    expect(getCohort(db, DEP_ID)!.status).toBe("waiting");

    // Step 2: operator confirms merge — waiting cohort is not touched (plan approval handles waiting→briefing)
    await patch(COHORT_ID, { status: "merged" });
    expect(getCohort(db, COHORT_ID)!.status).toBe("done");
    expect(getCohort(db, DEP_ID)!.status).toBe("waiting");
  });
});
