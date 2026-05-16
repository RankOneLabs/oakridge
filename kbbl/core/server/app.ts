import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import type { Database } from "bun:sqlite";

import type { AppRuntime } from "../runtime";
import type { SafirClient } from "../safir/client";
import type { KbblConfig } from "../config";
import type { SessionManager } from "../session/session-manager";
import { inboxHandler } from "../stream/inbox";
import { mountHandoffRoutes } from "./handlers/handoff";
import { mountPermissionRoutes } from "./handlers/permission";
import { mountPerSidRoutes } from "./handlers/per-sid";
import { mountProjectsRoutes } from "./handlers/projects";
import { mountSpecsRoutes } from "./handlers/specs";
import { mountPlansRoutes } from "./handlers/plans";
import { mountPlanStatusRoutes } from "./handlers/plan-status";
import { mountPlanReopenRoutes } from "./handlers/plan-reopen";
import { mountBriefStatusRoutes } from "./handlers/brief-status";
import { mountCohortsRoutes } from "./handlers/cohorts";
import { mountCohortStatusRoutes } from "./handlers/cohort-status";
import { mountBriefsRoutes } from "./handlers/briefs";
import { mountReviewFreezeRoutes } from "./handlers/review-freeze";
import { mountReviewAtomsRoutes } from "./handlers/review-atoms";
import { mountReviewThreadsRoutes } from "./handlers/review-threads";
import { mountSessionsRoutes } from "./handlers/sessions";
import { mountWorkspaceEventsRoutes } from "./handlers/workspace-events";
import { mountArtifactStreamRoutes } from "./handlers/artifact-stream";
import { artifactEventBus } from "../stream/artifact-event-bus";

export interface CreateAppDeps {
  manager: SessionManager;
  /** Adapter owns adapter-specific routes (e.g., CC's /hook/approval). */
  runtime: AppRuntime;
  /** The server's default workdir (from --workdir CLI arg). */
  defaultWorkdir: string;
  /** Path to the on-disk sessions directory. */
  sessionsDir: string;
  /** Path to the on-disk handoffs directory (`<dataDir>/handoffs`). */
  handoffsDir: string;
  /** Path to the built PWA dist directory served as static files. */
  pwaDistDir: string;
  /**
   * Same client the manager uses; threaded through deps so the permission
   * route (and any future safir-coupled handler) can share token + base URL
   * with the manager. Tests construct the manager + app with their own
   * stubbed client.
   */
  safirClient: SafirClient;
  /**
   * Returns the Bun server instance for `requestIP` loopback verification
   * inside the runtime's hook handler. Must be a getter (not the value)
   * because bunServer is assigned after Bun.serve(), which happens after
   * this call.
   */
  getBunServer: () => import("bun").Server<unknown> | null;
  /**
   * Shared mutable config. PATCH /config mutates config.compact.soft_threshold_tokens
   * in-place so all compactor instances pick up the new value immediately (they
   * hold a reference to config.compact and read soft_threshold_tokens on each
   * observeAssistantTurn call).
   */
  config: KbblConfig;
  /** Absolute path to config.json on disk for PATCH /config to persist changes. */
  configPath: string;
  /** Open SQLite database instance shared across all DB-backed handlers. */
  db: Database;
}

/**
 * Constructs the Hono app with all routes registered. The order of
 * registrations matters: runtime routes (e.g., /hook/approval) must come
 * before /:sid/* so Hono's route-matching doesn't catch POST /hook/approval
 * as /:sid/approval.
 */
export function createApp(deps: CreateAppDeps): Hono {
  const {
    manager,
    runtime,
    defaultWorkdir,
    sessionsDir,
    handoffsDir,
    pwaDistDir,
    safirClient,
    getBunServer,
    config,
    configPath,
    db,
  } = deps;
  const app = new Hono();

  // ---- runtime routes (loopback-only adapter endpoints) ----
  //
  // Registered BEFORE /:sid/* so Hono's registration-order match doesn't
  // catch routes like POST /hook/approval as /:sid/approval with sid="hook".
  runtime.mountRoutes(app, { manager, getBunServer });

  // ---- per-sid routes ----
  mountPerSidRoutes(app, { manager, sessionsDir });

  // ---- per-sid permission routes ----
  //
  // POST /:sid/permission/approve-for-task persists an auto-approve rule to
  // the session's task default profile so future sessions inherit it.
  mountPermissionRoutes(app, { manager, safirClient });

  // ---- per-sid handoff ----
  //
  // GET /:sid/handoff serves the compaction handoff markdown the PWA's
  // CompactedBanner renders for compacted predecessors. Mounted alongside
  // the other per-sid routes so it shares the UUID-v4 sid validator and
  // stays grouped with the per-session surfaces.
  mountHandoffRoutes(app, { handoffsDir });

  // ---- server config ----
  //
  // Exposes the operator-configured defaults the PWA needs to render forms.
  // PATCH /config allows runtime mutation of soft_threshold_tokens, persisted
  // back to configPath so the value survives a server restart.
  app.get("/config", (c) =>
    c.json({
      defaultWorkdir,
      softThresholdTokens: config.compact.soft_threshold_tokens,
      safirWebUrl: config.safir.web_url,
    }),
  );

  app.patch("/config", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    if (typeof body !== "object" || body === null) {
      return c.json({ error: "body must be an object" }, 400);
    }
    const b = body as { softThresholdTokens?: unknown; safirWebUrl?: unknown };
    const hasSoftThreshold = "softThresholdTokens" in b;
    const hasSafirWebUrl = "safirWebUrl" in b;
    if (!hasSoftThreshold && !hasSafirWebUrl) {
      return c.json({ error: "no settable fields in body" }, 400);
    }
    if (hasSoftThreshold) {
      const { softThresholdTokens } = b;
      if (
        typeof softThresholdTokens !== "number" ||
        !Number.isInteger(softThresholdTokens) ||
        softThresholdTokens <= 0
      ) {
        return c.json(
          { error: "softThresholdTokens must be a positive integer" },
          400,
        );
      }
      if (softThresholdTokens >= config.compact.hard_threshold_tokens) {
        return c.json(
          {
            error: `softThresholdTokens must be < hardThresholdTokens (${config.compact.hard_threshold_tokens})`,
          },
          400,
        );
      }
    }
    if (hasSafirWebUrl) {
      const { safirWebUrl } = b;
      if (typeof safirWebUrl !== "string" || !z.url().safeParse(safirWebUrl).success) {
        return c.json({ error: "safirWebUrl must be a valid URL" }, 400);
      }
      const parsed = new URL(safirWebUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return c.json({ error: "safirWebUrl must be a valid URL" }, 400);
      }
    }
    const newSoftThreshold = hasSoftThreshold
      ? (b.softThresholdTokens as number)
      : config.compact.soft_threshold_tokens;
    const newSafirWebUrl = hasSafirWebUrl
      ? (b.safirWebUrl as string)
      : config.safir.web_url;
    try {
      await writeFile(
        configPath,
        JSON.stringify({
          ...config,
          compact: { ...config.compact, soft_threshold_tokens: newSoftThreshold },
          safir: { ...config.safir, web_url: newSafirWebUrl },
        }, null, 2),
        "utf8",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `failed to persist config: ${msg}` }, 500);
    }
    config.compact.soft_threshold_tokens = newSoftThreshold;
    config.safir.web_url = newSafirWebUrl;
    return c.json({
      defaultWorkdir,
      softThresholdTokens: config.compact.soft_threshold_tokens,
      safirWebUrl: config.safir.web_url,
    });
  });

  // ---- sessions CRUD ----
  mountSessionsRoutes(app, { manager, defaultWorkdir, sessionsDir });

  // ---- workspace-layer event ingest ----
  //
  // POST /inbox/workspace-events lets legit-biz-club push project
  // lifecycle and coordination events through to inbox subscribers
  // without kbbl interpreting them.
  mountWorkspaceEventsRoutes(app, { manager });

  // ---- projects CRUD ----
  mountProjectsRoutes(app, { db });

  // ---- task-tracker CRUD (specs, plans, cohorts, briefs) ----
  mountSpecsRoutes(app, { db });
  mountPlansRoutes(app, { db });
  mountPlanStatusRoutes(app, { db });
  mountPlanReopenRoutes(app, { db });
  mountCohortsRoutes(app, { db });
  mountCohortStatusRoutes(app, { db });
  mountBriefsRoutes(app, { db });
  mountBriefStatusRoutes(app, { db });

  // ---- review primitive (cohort 2) ----
  mountReviewFreezeRoutes(app, { db });
  mountReviewAtomsRoutes(app, { db });
  mountReviewThreadsRoutes(app, { db });

  // ---- artifact SSE stream ----
  //
  // GET /safir-stream?target_type=&target_id= — review events (cohort 2)
  // publish into artifactEventBus via the mirror adapter in
  // kbbl/core/review/events.ts, so this route carries atom edits, thread
  // activity, and freeze transitions to the PWA.
  mountArtifactStreamRoutes(app, { bus: artifactEventBus });

  // ---- /inbox (always-on delta stream) ----
  app.get("/inbox", inboxHandler(manager));

  // ---- static PWA ----
  app.use(
    "/*",
    serveStatic({
      root: pwaDistDir,
      rewriteRequestPath: (path) => (path === "/" ? "/index.html" : path),
    }),
  );

  return app;
}
