import { writeFile } from "node:fs/promises";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import type { Database } from "bun:sqlite";

import type { AppRuntime, RuntimeRegistry } from "../runtime";
import type { KbblConfig } from "../config";
import type { SessionManager } from "../session/session-manager";
import type { createDispatcher } from "../orchestrator/backends/dispatcher";
import {
  makeControlAuthMiddleware,
  makeCookieHandler,
  type AuthPolicy,
} from "./auth";
import { inboxHandler } from "../stream/inbox";
import { mountHandoffRoutes } from "./handlers/handoff";
import { mountPerSidRoutes } from "./handlers/per-sid";
import { mountProjectsRoutes } from "./handlers/projects";
import { mountSpecsRoutes } from "./handlers/specs";
import { mountPlansRoutes } from "./handlers/plans";
import { mountPlanStatusRoutes } from "./handlers/plan-status";
import { mountPlanReopenRoutes } from "./handlers/plan-reopen";
import { mountBriefStatusRoutes } from "./handlers/brief-status";
import { mountBuildsRoutes } from "./handlers/builds";
import { mountCohortsRoutes } from "./handlers/cohorts";
import { mountCohortStatusRoutes } from "./handlers/cohort-status";
import { mountCohortMergeRoutes } from "./handlers/cohort-merge";
import * as ghGateway from "../github/gh-gateway";
import { mountBriefsRoutes } from "./handlers/briefs";
import { mountAssessmentsRoutes } from "./handlers/assessments";
import { mountEpicsRoutes } from "./handlers/epics";
import { mountSpecDiscrepanciesRoutes } from "./handlers/spec-discrepancies";
import { mountSpecStatusRoutes } from "./handlers/spec-status";
import { mountReviewFreezeRoutes } from "./handlers/review-freeze";
import { mountReviewAtomsRoutes } from "./handlers/review-atoms";
import { mountReviewThreadsRoutes } from "./handlers/review-threads";
import { mountSessionsRoutes } from "./handlers/sessions";
import { mountDirectoriesRoutes } from "./handlers/directories";
import { mountWorkspaceEventsRoutes } from "./handlers/workspace-events";
import { mountArtifactStreamRoutes } from "./handlers/artifact-stream";
import { artifactEventBus } from "../stream/artifact-event-bus";
import { mountSkillsRoutes } from "../skills/routes";
import { mountOakridgeProxyRoutes } from "./handlers/oakridge-proxy";

export interface CreateAppDeps {
  manager: SessionManager;
  /** Adapter owns adapter-specific routes (e.g., CC's /hook/approval). */
  runtime: AppRuntime;
  /**
   * Runtime registry. When provided, GET /config includes
   * `defaultRuntimeId` and `runtimes`, and POST /sessions uses the
   * registry for model validation. Optional for backward compat.
   */
  registry?: RuntimeRegistry;
  /** Optional server default workdir (from --workdir CLI arg). */
  defaultWorkdir: string | null;
  /** Path to the on-disk sessions directory. */
  sessionsDir: string;
  /** Path to the on-disk handoffs directory (`<dataDir>/handoffs`). */
  handoffsDir: string;
  /** Path to the built PWA dist directory served as static files. */
  pwaDistDir: string;
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
  /** Dispatcher for stage-based agent dispatch; mounts POST /briefs/:id/build. */
  dispatcher: ReturnType<typeof createDispatcher>;
  /**
   * Startup auth policy resolved from host + OAKRIDGE_CONTROL_TOKEN +
   * ALLOW_INSECURE_NON_LOOPBACK_CONTROL. Defaults to loopback when absent
   * (keeps the test helper buildApp() signature backward-compatible).
   */
  authPolicy?: AuthPolicy;
  /**
   * Token injected into proxied oakridge-core write requests.
   * Falls back to OAKRIDGE_CONTROL_TOKEN when OAKRIDGE_CORE_CONTROL_TOKEN
   * is not set. Undefined when no token is configured.
   */
  coreControlToken?: string;
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
    registry,
    defaultWorkdir,
    sessionsDir,
    handoffsDir,
    pwaDistDir,
    getBunServer,
    config,
    configPath,
    db,
    dispatcher,
    authPolicy = { mode: "loopback" },
    coreControlToken,
  } = deps;
  const app = new Hono();

  // ---- control auth middleware ----
  //
  // Applied globally before any route so every non-GET/HEAD request other
  // than /hook/* adapter routes requires authentication when the server is
  // bound to a non-loopback address. In loopback or insecure mode this is
  // a no-op pass-through so local development stays frictionless.
  app.use("/*", makeControlAuthMiddleware(authPolicy));

  // ---- cookie establishment endpoint ----
  //
  // POST /auth/cookie validates a Bearer token and sets an HttpOnly
  // SameSite=Lax cookie so the browser PWA can make subsequent control
  // calls without re-sending the token as a header (which would require
  // storing it in JS-accessible state).
  app.post("/auth/cookie", makeCookieHandler(authPolicy));

  // ---- runtime routes (loopback-only adapter endpoints) ----
  //
  // Registered BEFORE /:sid/* so Hono's registration-order match doesn't
  // catch routes like POST /hook/approval as /:sid/approval with sid="hook".
  runtime.mountRoutes(app, { manager, getBunServer });

  // ---- per-sid routes ----
  mountPerSidRoutes(app, { manager, sessionsDir });

  // ---- per-sid skills ----
  mountSkillsRoutes(app, { manager, registry, config });

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
  app.get("/config", (c) => {
    const base = {
      defaultWorkdir,
      softThresholdTokens: config.compact.soft_threshold_tokens,
    };
    if (registry) {
      return c.json({
        ...base,
        defaultRuntimeId: registry.defaultId,
        runtimes: [...registry.runtimes.values()].map((r) => r.descriptor),
      });
    }
    return c.json(base);
  });

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
    const b = body as { softThresholdTokens?: unknown };
    if (!("softThresholdTokens" in b)) {
      return c.json({ error: "no settable fields in body" }, 400);
    }
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
    try {
      await writeFile(
        configPath,
        JSON.stringify({
          ...config,
          compact: { ...config.compact, soft_threshold_tokens: softThresholdTokens },
        }, null, 2),
        "utf8",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `failed to persist config: ${msg}` }, 500);
    }
    config.compact.soft_threshold_tokens = softThresholdTokens;
    return c.json({
      defaultWorkdir,
      softThresholdTokens: config.compact.soft_threshold_tokens,
    });
  });

  // ---- sessions CRUD ----
  mountSessionsRoutes(app, { manager, defaultWorkdir, sessionsDir, registry });

  // ---- local directory browser ----
  mountDirectoriesRoutes(app, { defaultWorkdir });

  // ---- workspace-layer event ingest ----
  //
  // POST /inbox/workspace-events lets legit-biz-club push project
  // lifecycle and coordination events through to inbox subscribers
  // without kbbl interpreting them.
  mountWorkspaceEventsRoutes(app, { manager });

  // ---- projects CRUD ----
  mountProjectsRoutes(app, { db });

  // ---- task-tracker CRUD (specs, plans, cohorts, briefs) ----
  mountSpecsRoutes(app, { db, registry });
  mountSpecDiscrepanciesRoutes(app, { db });
  mountSpecStatusRoutes(app, { db });
  mountPlansRoutes(app, { db });
  mountPlanStatusRoutes(app, { db });
  mountPlanReopenRoutes(app, { db });
  mountCohortsRoutes(app, { db, manager });
  mountCohortStatusRoutes(app, { db });
  mountCohortMergeRoutes(app, { db, gh: ghGateway });
  mountBriefsRoutes(app, { db });
  mountBriefStatusRoutes(app, { db });
  mountBuildsRoutes(app, { db, dispatcher, manager });
  mountAssessmentsRoutes(app, { db });
  mountEpicsRoutes(app, { db });

  // ---- review primitive (cohort 2) ----
  mountReviewFreezeRoutes(app, { db });
  mountReviewAtomsRoutes(app, { db });
  mountReviewThreadsRoutes(app, { db });

  // ---- artifact SSE stream ----
  //
  // GET /artifact-stream?target_type=&target_id= — review events publish
  // into artifactEventBus via the mirror adapter in kbbl/core/review/events.ts,
  // so this route carries atom edits, thread activity, and freeze transitions
  // to the PWA.
  mountArtifactStreamRoutes(app, { bus: artifactEventBus });

  // ---- oakridge-core proxy ----
  //
  // GET /oakridge/config → { available: boolean } (PWA availability check)
  // ALL /oakridge/api/* → proxied to OAKRIDGE_CORE_BASE_URL (same-origin CORS avoidance)
  // Write requests are validated against kbbl auth (via the global middleware
  // above) before reaching this handler; the handler then injects the core
  // control token so oakridge-core's own auth gate is satisfied.
  mountOakridgeProxyRoutes(app, {
    baseUrl: process.env.OAKRIDGE_CORE_BASE_URL,
    coreControlToken,
  });

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
