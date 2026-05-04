import { Hono } from "hono";
import { serveStatic } from "hono/bun";

import type { SessionManager } from "../session/session-manager";
import { inboxHandler } from "../stream/inbox";
import { hookApprovalHandler } from "../../adapters/claude-code/hook-route";
import { mountPerSidRoutes } from "./handlers/per-sid";
import { mountSessionsRoutes } from "./handlers/sessions";

export interface CreateAppDeps {
  manager: SessionManager;
  /** The server's default workdir (from --workdir CLI arg). */
  defaultWorkdir: string;
  /** Path to the on-disk sessions directory. */
  sessionsDir: string;
  /** Path to the built PWA dist directory served as static files. */
  pwaDistDir: string;
  /**
   * Returns the Bun server instance for `requestIP` loopback verification
   * inside the hook handler. Must be a getter (not the value) because
   * bunServer is assigned after Bun.serve(), which happens after this call.
   */
  getBunServer: () => import("bun").Server<unknown> | null;
}

/**
 * Constructs the Hono app with all routes registered. The order of
 * registrations matters: /hook/approval must come before /:sid/* so Hono's
 * route-matching doesn't catch POST /hook/approval as /:sid/approval.
 */
export function createApp(deps: CreateAppDeps): Hono {
  const { manager, defaultWorkdir, sessionsDir, pwaDistDir, getBunServer } =
    deps;
  const app = new Hono();

  // ---- hook (loopback-only) ----
  //
  // Registered BEFORE /:sid/* so Hono's registration-order match doesn't
  // catch POST /hook/approval as /:sid/approval with sid="hook".
  // Handler is CC-coupled; moves into the claude-code adapter in PR 3.
  app.post("/hook/approval", hookApprovalHandler({ manager, getBunServer }));

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
