import type { Context, Hono } from "hono";

import { SafirHttpError, type SafirClient } from "../../safir/client";

export interface SafirProxyRouteDeps {
  /**
   * Same `SafirClient` instance the manager uses. Constructed once in
   * `core/server.ts` so token + base URL stay in one place. The proxy
   * only invokes the read methods (`getTask`, `listTasks`,
   * `listHandoffsForTask`, `getHandoff`); write methods are deliberately
   * out of scope for the proxy and called only by the lifecycle path.
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
 * Validate the `:taskId` URL segment as a positive integer. safir's task
 * IDs are INTEGER PRIMARY KEY; rejecting non-numeric IDs at the kbbl
 * boundary keeps a malformed PWA URL from triggering an upstream 4xx
 * round-trip and surfaces a clear 400 the PWA can branch on.
 */
function parseTaskId(raw: string): number | null {
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
    const taskId = parseTaskId(c.req.param("taskId"));
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
    const taskId = parseTaskId(c.req.param("taskId"));
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
}
