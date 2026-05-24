import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { openTestDb } from "../../db/test-db";
import { insertProject } from "../../db/projects";
import { insertSpec } from "../../db/specs";
import { insertPlan } from "../../db/plans";
import { insertCohort, getCohort, insertCohortDependency } from "../../db/cohorts";
import { insertBrief } from "../../db/briefs";
import { taskTrackerEvents } from "../../db/events";
import { mountCohortMergeRoutes, type GhGateway, type MergeOutcome } from "./cohort-merge";
import type { PrState, GhError, ReviewThread } from "../../github/gh-gateway";

const PROJECT_ID = "proj-1";
const SPEC_ID = "spec-1";
const PLAN_ID = "plan-1";
const COHORT_ID = "cohort-1";
const PR_URL = "https://github.com/org/repo/pull/42";

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

function setBriefPrUrl(briefId: string, prUrl: string | null) {
  db.prepare("UPDATE briefs SET pr_url = ? WHERE id = ?").run(prUrl, briefId);
}

function post(id: string, body: unknown = {}) {
  return app.request(`/cohorts/${id}/merge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeFakeGh(prState: PrState): GhGateway {
  return {
    fetchPrState: async () => ({ ok: true, value: prState }),
    mergePr: async () => ({ ok: true, value: undefined }),
  };
}

function makeErrGh(err: GhError): GhGateway {
  return {
    fetchPrState: async () => ({ ok: false, error: err }),
    mergePr: async () => ({ ok: true, value: undefined }),
  };
}

function setupApp(gh: GhGateway) {
  app = new Hono();
  mountCohortMergeRoutes(app, { db, gh });
}

function setupAwaitingMerge(briefId = "b1", prUrl: string | null = PR_URL) {
  setStatus(COHORT_ID, "awaiting_merge");
  insertBrief(db, { id: briefId, cohort_id: COHORT_ID, ...BRIEF_DEFAULTS });
  if (prUrl !== null) setBriefPrUrl(briefId, prUrl);
}

beforeEach(() => {
  db = openTestDb();
  insertProject(db, { id: PROJECT_ID, name: "P", repo_path: "/p" });
  insertSpec(db, { id: SPEC_ID, project_id: PROJECT_ID, title: "S" });
  insertPlan(db, { id: PLAN_ID, spec_id: SPEC_ID });
  insertCohort(db, { id: COHORT_ID, plan_id: PLAN_ID, title: "C1", position: 1 });
});

afterEach(() => {
  db.close();
});

describe("POST /cohorts/:id/merge — error paths", () => {
  test("cohort not found → 404", async () => {
    setupApp(makeFakeGh({ kind: "open_mergeable_clean", url: PR_URL }));
    const res = await post("nonexistent");
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/not found/);
  });

  test("wrong cohort status → 409", async () => {
    setupApp(makeFakeGh({ kind: "open_mergeable_clean", url: PR_URL }));
    // cohort starts as "waiting", not awaiting_merge
    const res = await post(COHORT_ID);
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/awaiting_merge/);
  });

  test("no brief → 409", async () => {
    setStatus(COHORT_ID, "awaiting_merge");
    setupApp(makeFakeGh({ kind: "open_mergeable_clean", url: PR_URL }));
    const res = await post(COHORT_ID);
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/pr_url/);
  });

  test("brief.pr_url null → 409", async () => {
    setupAwaitingMerge("b1", null);
    setupApp(makeFakeGh({ kind: "open_mergeable_clean", url: PR_URL }));
    const res = await post(COHORT_ID);
    expect(res.status).toBe(409);
  });

  test("malformed pr_url → 422", async () => {
    setupAwaitingMerge("b1", "not-a-github-pr-url");
    setupApp(makeFakeGh({ kind: "open_mergeable_clean", url: PR_URL }));
    const res = await post(COHORT_ID);
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/malformed/);
  });

  test("gh_not_authenticated → 502 with structured detail", async () => {
    setupAwaitingMerge();
    setupApp(
      makeErrGh({ kind: "gh_not_authenticated", operation: "fetchPrState", prUrl: PR_URL }),
    );
    const res = await post(COHORT_ID);
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string; detail: { kind: string } };
    expect(body.error).toBe("gh failed");
    expect(body.detail.kind).toBe("gh_not_authenticated");
  });

  test("gh_failed → 502 with structured detail", async () => {
    setupAwaitingMerge();
    setupApp(
      makeErrGh({
        kind: "gh_failed",
        operation: "fetchPrState",
        prUrl: PR_URL,
        exitCode: 1,
        stderr: "timeout",
      }),
    );
    const res = await post(COHORT_ID);
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string; detail: { kind: string } };
    expect(body.error).toBe("gh failed");
    expect(body.detail.kind).toBe("gh_failed");
  });
});

describe("POST /cohorts/:id/merge — idempotency", () => {
  test("already done → 200 outcome=already_done without re-running fanout", async () => {
    setStatus(COHORT_ID, "done");
    const DEP_ID = "cohort-dep";
    insertCohort(db, { id: DEP_ID, plan_id: PLAN_ID, title: "dep", position: 2 });
    insertCohortDependency(db, { id: "d1", from_cohort_id: COHORT_ID, to_cohort_id: DEP_ID });
    setStatus(DEP_ID, "ready_to_build");
    insertBrief(db, { id: "b-dep", cohort_id: DEP_ID, ...BRIEF_DEFAULTS });
    db.prepare("UPDATE briefs SET status = 'approved' WHERE id = ?").run("b-dep");

    const doneEvts: unknown[] = [];
    const unsub = taskTrackerEvents.subscribe("cohort.done", (p) => doneEvts.push(p));
    setupApp(makeFakeGh({ kind: "open_mergeable_clean", url: PR_URL }));
    try {
      const res = await post(COHORT_ID);
      expect(res.status).toBe(200);
      const body = await res.json() as MergeOutcome;
      expect(body.outcome).toBe("already_done");
      // No fanout — dep stays ready_to_build
      expect(getCohort(db, DEP_ID)!.status).toBe("ready_to_build");
      expect(doneEvts).toHaveLength(0);
    } finally {
      unsub();
    }
  });
});

describe("POST /cohorts/:id/merge — 5 happy outcomes", () => {
  test("already_merged → 200 merged via already_merged with merged_at, sets cohort done", async () => {
    setupAwaitingMerge();
    setupApp(makeFakeGh({ kind: "already_merged", mergedAt: "2024-01-01T00:00:00Z", url: PR_URL }));
    const res = await post(COHORT_ID);
    expect(res.status).toBe(200);
    const body = await res.json() as Extract<MergeOutcome, { outcome: "merged"; via: "already_merged" }>;
    expect(body.outcome).toBe("merged");
    expect(body.via).toBe("already_merged");
    expect(body.merged_at).toBe("2024-01-01T00:00:00Z");
    expect(getCohort(db, COHORT_ID)!.status).toBe("done");
  });

  test("open_mergeable_clean → 200 merged via merged_now, calls mergePr, sets cohort done", async () => {
    setupAwaitingMerge();
    let mergeCalled = false;
    setupApp({
      fetchPrState: async () => ({ ok: true, value: { kind: "open_mergeable_clean", url: PR_URL } }),
      mergePr: async () => { mergeCalled = true; return { ok: true, value: undefined }; },
    });
    const res = await post(COHORT_ID);
    expect(res.status).toBe(200);
    const body = await res.json() as MergeOutcome;
    expect(body.outcome).toBe("merged");
    expect((body as Extract<MergeOutcome, { outcome: "merged" }>).via).toBe("merged_now");
    expect(mergeCalled).toBe(true);
    expect(getCohort(db, COHORT_ID)!.status).toBe("done");
  });

  test("open_not_mergeable → 200 outcome=not_mergeable, no state change", async () => {
    setupAwaitingMerge();
    setupApp(makeFakeGh({ kind: "open_not_mergeable", reason: "conflicts", url: PR_URL }));
    const res = await post(COHORT_ID);
    expect(res.status).toBe(200);
    const body = await res.json() as Extract<MergeOutcome, { outcome: "not_mergeable" }>;
    expect(body.outcome).toBe("not_mergeable");
    expect(body.reason).toBe("conflicts");
    expect(getCohort(db, COHORT_ID)!.status).toBe("awaiting_merge");
  });

  test("closed_unmerged + confirm_closed → 200 merged via already_merged, no mergePr call", async () => {
    setupAwaitingMerge();
    let mergeCalled = false;
    setupApp({
      fetchPrState: async () => ({ ok: true, value: { kind: "closed_unmerged", url: PR_URL } }),
      mergePr: async () => { mergeCalled = true; return { ok: true, value: undefined }; },
    });
    const res = await post(COHORT_ID, { confirm_closed: true });
    expect(res.status).toBe(200);
    const body = await res.json() as Extract<MergeOutcome, { outcome: "merged"; via: "already_merged" }>;
    expect(body.outcome).toBe("merged");
    expect(body.via).toBe("already_merged");
    expect(body.merged_at).toBeNull();
    expect(mergeCalled).toBe(false);
    expect(getCohort(db, COHORT_ID)!.status).toBe("done");
  });

  test("open_mergeable_unresolved + confirm_unresolved → 200 merged via merged_now, calls mergePr", async () => {
    setupAwaitingMerge();
    const threads: ReviewThread[] = [
      { id: "t1", author: "reviewer", firstLineSnippet: "Fix this", deepLinkPath: "/pull/42#discussion_r1" },
    ];
    let mergeCalled = false;
    setupApp({
      fetchPrState: async () => ({
        ok: true,
        value: { kind: "open_mergeable_unresolved", threads, url: PR_URL },
      }),
      mergePr: async () => { mergeCalled = true; return { ok: true, value: undefined }; },
    });
    const res = await post(COHORT_ID, { confirm_unresolved: true });
    expect(res.status).toBe(200);
    const body = await res.json() as MergeOutcome;
    expect(body.outcome).toBe("merged");
    expect((body as Extract<MergeOutcome, { outcome: "merged" }>).via).toBe("merged_now");
    expect(mergeCalled).toBe(true);
    expect(getCohort(db, COHORT_ID)!.status).toBe("done");
  });
});

describe("POST /cohorts/:id/merge — confirm-required branches without flags", () => {
  test("open_mergeable_unresolved without confirm_unresolved → confirm_unresolved, no state change", async () => {
    setupAwaitingMerge();
    const threads: ReviewThread[] = [
      { id: "t1", author: "reviewer", firstLineSnippet: "Fix this", deepLinkPath: "/pull/42#discussion_r1" },
    ];
    setupApp(makeFakeGh({ kind: "open_mergeable_unresolved", threads, url: PR_URL }));
    const res = await post(COHORT_ID);
    expect(res.status).toBe(200);
    const body = await res.json() as Extract<MergeOutcome, { outcome: "confirm_unresolved" }>;
    expect(body.outcome).toBe("confirm_unresolved");
    expect(body.threads).toHaveLength(1);
    expect(body.threads[0]!.id).toBe("t1");
    expect(getCohort(db, COHORT_ID)!.status).toBe("awaiting_merge");
  });

  test("closed_unmerged without confirm_closed → confirm_closed, no state change", async () => {
    setupAwaitingMerge();
    setupApp(makeFakeGh({ kind: "closed_unmerged", url: PR_URL }));
    const res = await post(COHORT_ID);
    expect(res.status).toBe(200);
    const body = await res.json() as MergeOutcome;
    expect(body.outcome).toBe("confirm_closed");
    expect(getCohort(db, COHORT_ID)!.status).toBe("awaiting_merge");
  });
});

describe("POST /cohorts/:id/merge — confirm branches with flags", () => {
  test("open_mergeable_unresolved + confirm_unresolved=true → merged via merged_now", async () => {
    setupAwaitingMerge();
    const threads: ReviewThread[] = [
      { id: "t1", author: "reviewer", firstLineSnippet: "Fix this", deepLinkPath: "/pull/42#discussion_r1" },
    ];
    setupApp(makeFakeGh({ kind: "open_mergeable_unresolved", threads, url: PR_URL }));
    const res = await post(COHORT_ID, { confirm_unresolved: true });
    expect(res.status).toBe(200);
    const body = await res.json() as MergeOutcome;
    expect(body.outcome).toBe("merged");
    expect(getCohort(db, COHORT_ID)!.status).toBe("done");
  });

  test("closed_unmerged + confirm_closed=true → merged via already_merged, does NOT call mergePr", async () => {
    setupAwaitingMerge();
    let mergeCalled = false;
    setupApp({
      fetchPrState: async () => ({ ok: true, value: { kind: "closed_unmerged", url: PR_URL } }),
      mergePr: async () => { mergeCalled = true; return { ok: true, value: undefined }; },
    });
    const res = await post(COHORT_ID, { confirm_closed: true });
    expect(res.status).toBe(200);
    const body = await res.json() as Extract<MergeOutcome, { outcome: "merged"; via: "already_merged" }>;
    expect(body.outcome).toBe("merged");
    expect(body.via).toBe("already_merged");
    expect(body.merged_at).toBeNull();
    expect(mergeCalled).toBe(false);
    expect(getCohort(db, COHORT_ID)!.status).toBe("done");
  });
});

describe("POST /cohorts/:id/merge — event emission", () => {
  test("merged outcome emits cohort.pr_merged and cohort.done", async () => {
    setupAwaitingMerge();
    setupApp(makeFakeGh({ kind: "already_merged", mergedAt: null, url: PR_URL }));
    const mergedEvts: { cohort_id: string }[] = [];
    const doneEvts: { cohort_id: string }[] = [];
    const u1 = taskTrackerEvents.subscribe("cohort.pr_merged", (p) => mergedEvts.push(p));
    const u2 = taskTrackerEvents.subscribe("cohort.done", (p) => doneEvts.push(p));
    try {
      await post(COHORT_ID);
      expect(mergedEvts).toEqual([{ cohort_id: COHORT_ID }]);
      expect(doneEvts).toEqual([{ cohort_id: COHORT_ID }]);
    } finally {
      u1();
      u2();
    }
  });

  test("merged outcome emits plan.completed when last cohort in plan", async () => {
    setupAwaitingMerge();
    setupApp(makeFakeGh({ kind: "already_merged", mergedAt: null, url: PR_URL }));
    const completedEvts: { plan_id: string }[] = [];
    const unsub = taskTrackerEvents.subscribe("plan.completed", (p) => completedEvts.push(p));
    try {
      await post(COHORT_ID);
      expect(completedEvts).toHaveLength(1);
      expect(completedEvts[0]!.plan_id).toBe(PLAN_ID);
    } finally {
      unsub();
    }
  });

  test("merged outcome emits cohort.build_ready for ready_to_build deps with approved brief", async () => {
    const DEP_ID = "cohort-dep";
    insertCohort(db, { id: DEP_ID, plan_id: PLAN_ID, title: "dep", position: 2 });
    insertCohortDependency(db, { id: "d1", from_cohort_id: COHORT_ID, to_cohort_id: DEP_ID });
    setStatus(DEP_ID, "ready_to_build");
    insertBrief(db, { id: "b-dep", cohort_id: DEP_ID, ...BRIEF_DEFAULTS });
    db.prepare("UPDATE briefs SET status = 'approved' WHERE id = ?").run("b-dep");

    setupAwaitingMerge();
    setupApp(makeFakeGh({ kind: "already_merged", mergedAt: null, url: PR_URL }));
    const buildReadyEvts: { cohort_id: string; brief_id: string }[] = [];
    const unsub = taskTrackerEvents.subscribe("cohort.build_ready", (p) => buildReadyEvts.push(p));
    try {
      await post(COHORT_ID);
      expect(buildReadyEvts).toHaveLength(1);
      expect(buildReadyEvts[0]!.cohort_id).toBe(DEP_ID);
    } finally {
      unsub();
    }
  });

  test("non-merged outcomes do not emit cohort.done", async () => {
    setupAwaitingMerge();
    setupApp(makeFakeGh({ kind: "closed_unmerged", url: PR_URL }));
    const doneEvts: unknown[] = [];
    const unsub = taskTrackerEvents.subscribe("cohort.done", (p) => doneEvts.push(p));
    try {
      await post(COHORT_ID);
      expect(doneEvts).toHaveLength(0);
    } finally {
      unsub();
    }
  });
});
