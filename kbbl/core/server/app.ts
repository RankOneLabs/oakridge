import { Hono } from "hono";
import { serveStatic } from "hono/bun";

import type { AppRuntime } from "../runtime";
import type { SessionManager } from "../session/session-manager";
import { inboxHandler } from "../stream/inbox";
import { mountPerSidRoutes } from "./handlers/per-sid";
import { mountSafirWebhookRoutes } from "./handlers/safir-webhook";
import { mountSessionsRoutes } from "./handlers/sessions";
import { mountWorkspaceEventsRoutes } from "./handlers/workspace-events";

export interface CreateAppDeps {
  manager: SessionManager;
  /** Adapter owns adapter-specific routes (e.g., CC's /hook/approval). */
  runtime: AppRuntime;
  /** The server's default workdir (from --workdir CLI arg). */
  defaultWorkdir: string;
  /** Path to the on-disk sessions directory. */
  sessionsDir: string;
  /** Path to the built PWA dist directory served as static files. */
  pwaDistDir: string;
  /**
   * Returns the Bun server instance for `requestIP` loopback verification
   * inside the runtime's hook handler. Must be a getter (not the value)
   * because bunServer is assigned after Bun.serve(), which happens after
   * this call.
   */
  getBunServer: () => import("bun").Server<unknown> | null;
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
    pwaDistDir,
    getBunServer,
  } = deps;
  const app = new Hono();

  // ---- runtime routes (loopback-only adapter endpoints) ----
  //
  // Registered BEFORE /:sid/* so Hono's registration-order match doesn't
  // catch routes like POST /hook/approval as /:sid/approval with sid="hook".
  runtime.mountRoutes(app, { manager, getBunServer });

  // ---- per-sid routes ----
  mountPerSidRoutes(app, { manager, sessionsDir });

  // ---- server config ----
  //
  // Exposes the operator-configured defaults the PWA needs to render forms
  // (currently just the default workdir). Kept tiny on purpose: this is not
  // a place to grow generic settings — anything per-session belongs in the
  // session snapshot.
  app.get("/config", (c) => c.json({ defaultWorkdir }));

  // ---- sessions CRUD ----
  mountSessionsRoutes(app, { manager, defaultWorkdir, sessionsDir });

  // ---- workspace-layer event ingest ----
  //
  // POST /inbox/workspace-events lets legit-biz-club push project
  // lifecycle and coordination events through to inbox subscribers
  // without kbbl interpreting them.
  mountWorkspaceEventsRoutes(app, { manager });

  // ---- safir webhook receiver ----
  //
  // POST /webhooks/safir is registered before the static `/*` catch-all
  // so the webhook path doesn't get rewritten as a static-file lookup.
  mountSafirWebhookRoutes(app, { manager });

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
