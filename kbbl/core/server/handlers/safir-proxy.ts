import type { Context, Hono } from "hono";

import { SafirHttpError, type SafirClient } from "../../safir/client";

export interface SafirProxyRouteDeps {
  /**
   * Same `SafirClient` instance the manager uses. Constructed once in
   * `core/server.ts` so token + base URL stay in one place. The proxy
   * invokes read methods (`getTask`, `listTasks`, `listHandoffsForTask`,
   * `getHandoff`) and limited plan-review writes (`updatePlanStatus`,
   * `reopenPlan`) for the PWA review flow.
   */
  safirClient: SafirClient;
}

/**
 * `GET /safir/...` proxy used by the PWA spine view to read safir's
 * project + handoff state without CORS or auth-secret leakage to the
 * browser. Pass-through only — no reshaping, no caching, no retry.
 *
 * Error mapping:
 *   SafirHttpError → response uses safir's status, body is `{ error,
 *     status, body }` so the PWA can surface both the human-readable
 *     error and the raw safir payload for debugging.
 *   Anything else (network, timeout via AbortController) → 502 with
 *     `{ error: "safir unreachable" }`. 502 is the convention for an
 *     upstream proxy failure and is what the PWA branches on to render
 *     "is safir running?" rather than the generic safir-error UI.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function respondToUpstreamError(c: Context<any, any, any>, err: unknown) {
  if (err instanceof SafirHttpError) {
    return c.json(
      {
        error: `safir HTTP ${err.status}`,
        status: err.status,
        body: err.body,
      },
      // Hono's c.json status arg is typed as a Hono status union. Safir
      // can return any 4xx/5xx; cast here so the proxy preserves whatever
      // status came back rather than silently rewriting it.
      err.status as Parameters<typeof c.json>[1],
    );
  }
  return c.json({ error: "safir unreachable" }, 502);
}

/**
 * Validate a URL segment as a positive safe integer. safir IDs are
 * INTEGER PRIMARY KEY; rejecting non-decimal or unsafe values at the kbbl
 * boundary keeps malformed URLs from triggering upstream 4xx round-trips.
 */
function parsePositiveInt(raw: string): number | null {
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) ? n : null;
}

export function mountSafirProxyRoutes(
  app: Hono,
  deps: SafirProxyRouteDeps,
): void {
  const { safirClient } = deps;

  app.get("/safir/tasks", async (c) => {
    try {
      const tasks = await safirClient.listTasks();
      return c.json(tasks);
    } catch (err) {
      return respondToUpstreamError(c, err);
    }
  });

  app.get("/safir/tasks/:taskId", async (c) => {
    const taskId = parsePositiveInt(c.req.param("taskId"));
    if (taskId === null) {
      return c.json(
        { error: "taskId must be a positive integer" },
        400,
      );
    }
    try {
      const task = await safirClient.getTask(taskId);
      return c.json(task);
    } catch (err) {
      return respondToUpstreamError(c, err);
    }
  });

  app.get("/safir/tasks/:taskId/handoffs", async (c) => {
    const taskId = parsePositiveInt(c.req.param("taskId"));
    if (taskId === null) {
      return c.json(
        { error: "taskId must be a positive integer" },
        400,
      );
    }
    try {
      const handoffs = await safirClient.listHandoffsForTask(taskId);
      return c.json(handoffs);
    } catch (err) {
      return respondToUpstreamError(c, err);
    }
  });

  app.get("/safir/handoffs/:handoffId", async (c) => {
    const handoffId = c.req.param("handoffId").trim();
    if (handoffId === "") {
      return c.json(
        { error: "handoffId must be a non-empty string" },
        400,
      );
    }
    try {
      const handoff = await safirClient.getHandoff(handoffId);
      return c.json(handoff);
    } catch (err) {
      return respondToUpstreamError(c, err);
    }
  });

  app.get("/safir/permission-profiles", async (c) => {
    try {
      const profiles = await safirClient.listPermissionProfiles();
      return c.json(profiles);
    } catch (err) {
      return respondToUpstreamError(c, err);
    }
  });

  app.get("/safir/permission-profiles/:id", async (c) => {
    const idParam = c.req.param("id");
    const id = parsePositiveInt(idParam);
    if (id === null) {
      return c.json({ error: `invalid permission profile id: '${idParam}'` }, 400);
    }
    try {
      const profile = await safirClient.getPermissionProfile(id);
      return c.json(profile);
    } catch (err) {
      return respondToUpstreamError(c, err);
    }
  });

  app.get("/safir/tasks/:taskId/plans", async (c) => {
    const taskId = parsePositiveInt(c.req.param("taskId"));
    if (taskId === null) {
      return c.json({ error: "taskId must be a positive integer" }, 400);
    }
    try {
      const plans = await safirClient.listPlansForTask(taskId);
      return c.json(plans);
    } catch (err) {
      return respondToUpstreamError(c, err);
    }
  });

  app.get("/safir/plans/:planId", async (c) => {
    const planId = c.req.param("planId").trim();
    if (planId === "") {
      return c.json({ error: "planId must be a non-empty string" }, 400);
    }
    try {
      const plan = await safirClient.getPlan(planId);
      return c.json(plan);
    } catch (err) {
      return respondToUpstreamError(c, err);
    }
  });

  app.patch("/safir/plans/:planId/status", async (c) => {
    const planId = c.req.param("planId").trim();
    if (planId === "") {
      return c.json({ error: "planId must be a non-empty string" }, 400);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    try {
      const plan = await safirClient.updatePlanStatus(
        planId,
        body as { status: string; rejection_reason?: string | null },
      );
      return c.json(plan);
    } catch (err) {
      return respondToUpstreamError(c, err);
    }
  });

  app.post("/safir/plans/:planId/reopen", async (c) => {
    const planId = c.req.param("planId").trim();
    if (planId === "") {
      return c.json({ error: "planId must be a non-empty string" }, 400);
    }
    try {
      const plan = await safirClient.reopenPlan(planId);
      return c.json(plan);
    } catch (err) {
      return respondToUpstreamError(c, err);
    }
  });

  // --- cohort 2: atom + thread proxy routes ---

  app.get("/safir/atoms/:targetType/:targetId", async (c) => {
    const targetType = c.req.param("targetType").trim();
    const targetId = c.req.param("targetId").trim();
    if (!targetType || !targetId) return c.json({ error: "targetType and targetId required" }, 400);
    try {
      const map = await safirClient.getAtomMap(targetType, targetId);
      return c.json(map);
    } catch (err) { return respondToUpstreamError(c, err); }
  });

  app.get("/safir/atoms/:targetType/:targetId/history", async (c) => {
    const targetType = c.req.param("targetType").trim();
    const targetId = c.req.param("targetId").trim();
    if (!targetType || !targetId) return c.json({ error: "targetType and targetId required" }, 400);
    try {
      const history = await safirClient.listAtomHistory(targetType, targetId);
      return c.json(history);
    } catch (err) { return respondToUpstreamError(c, err); }
  });

  app.post("/safir/atoms/:targetType/:targetId/edits", async (c) => {
    const targetType = c.req.param("targetType").trim();
    const targetId = c.req.param("targetId").trim();
    if (!targetType || !targetId) return c.json({ error: "targetType and targetId required" }, 400);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid json" }, 400); }
    try {
      const result = await safirClient.postAtomEdit(targetType, targetId, body as Record<string, unknown>);
      return c.json(result);
    } catch (err) { return respondToUpstreamError(c, err); }
  });

  app.get("/safir/artifacts/:targetType/:targetId/threads", async (c) => {
    const targetType = c.req.param("targetType").trim();
    const targetId = c.req.param("targetId").trim();
    if (!targetType || !targetId) return c.json({ error: "targetType and targetId required" }, 400);
    try {
      const threads = await safirClient.listAllThreads(targetType, targetId);
      return c.json(threads);
    } catch (err) { return respondToUpstreamError(c, err); }
  });

  app.get("/safir/threads/:threadId", async (c) => {
    const threadId = c.req.param("threadId").trim();
    if (!threadId) return c.json({ error: "threadId required" }, 400);
    try {
      const thread = await safirClient.getThread(threadId);
      return c.json(thread);
    } catch (err) { return respondToUpstreamError(c, err); }
  });

  app.post("/safir/threads", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid json" }, 400); }
    try {
      const thread = await safirClient.createThread(body as Record<string, unknown>);
      return c.json(thread, 201);
    } catch (err) { return respondToUpstreamError(c, err); }
  });

  app.post("/safir/threads/:threadId/messages", async (c) => {
    const threadId = c.req.param("threadId").trim();
    if (!threadId) return c.json({ error: "threadId required" }, 400);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid json" }, 400); }
    try {
      const msg = await safirClient.postThreadMessage(threadId, body as { body: string; author: string });
      return c.json(msg, 201);
    } catch (err) { return respondToUpstreamError(c, err); }
  });

  app.post("/safir/threads/:threadId/ping", async (c) => {
    const threadId = c.req.param("threadId").trim();
    if (!threadId) return c.json({ error: "threadId required" }, 400);
    try {
      const result = await safirClient.pingThread(threadId);
      return c.json(result ?? { ok: true }, 202);
    } catch (err) { return respondToUpstreamError(c, err); }
  });

  app.patch("/safir/threads/:threadId/status", async (c) => {
    const threadId = c.req.param("threadId").trim();
    if (!threadId) return c.json({ error: "threadId required" }, 400);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid json" }, 400); }
    try {
      const thread = await safirClient.updateThreadStatus(threadId, body as { status: string });
      return c.json(thread);
    } catch (err) { return respondToUpstreamError(c, err); }
  });

  // --- cohort 3: build brief proxy routes ---

  app.get("/safir/build-briefs", async (c) => {
    const status = c.req.query("status");
    try {
      const briefs = await safirClient.listBuildBriefs(status);
      return c.json(briefs);
    } catch (err) { return respondToUpstreamError(c, err); }
  });

  app.get("/safir/build-briefs/:id", async (c) => {
    const id = c.req.param("id").trim();
    if (!id) return c.json({ error: "id required" }, 400);
    try {
      const brief = await safirClient.getBuildBrief(id);
      return c.json(brief);
    } catch (err) { return respondToUpstreamError(c, err); }
  });

  app.get("/safir/build-briefs/:id/run", async (c) => {
    const id = c.req.param("id").trim();
    if (!id) return c.json({ error: "id required" }, 400);
    try {
      const run = await safirClient.getBuildBriefRun(id);
      return c.json(run);
    } catch (err) { return respondToUpstreamError(c, err); }
  });

  app.patch("/safir/build-briefs/:id/status", async (c) => {
    const id = c.req.param("id").trim();
    if (!id) return c.json({ error: "id required" }, 400);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid json" }, 400); }
    try {
      const brief = await safirClient.updateBuildBriefStatus(id, body as Record<string, unknown>);
      return c.json(brief);
    } catch (err) { return respondToUpstreamError(c, err); }
  });

  app.post("/safir/build-briefs/:id/reopen", async (c) => {
    const id = c.req.param("id").trim();
    if (!id) return c.json({ error: "id required" }, 400);
    try {
      const brief = await safirClient.reopenBuildBrief(id);
      return c.json(brief);
    } catch (err) { return respondToUpstreamError(c, err); }
  });

  app.get("/safir/projects/:id/repo-path", async (c) => {
    const id = c.req.param("id").trim();
    if (!id) return c.json({ error: "id required" }, 400);
    try {
      const result = await safirClient.getProjectRepoPath(id);
      return c.json(result);
    } catch (err) { return respondToUpstreamError(c, err); }
  });
}
