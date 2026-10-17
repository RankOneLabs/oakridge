import { Hono } from "hono";
import { serveStatic } from "hono/bun";

import type { KbblConfig } from "../config";
import type { AcpSessionService } from "../acp/session-service";
import {
  makeAuthStatusHandler,
  makeControlAuthMiddleware,
  makeCookieHandler,
  type AuthPolicy,
} from "./auth";
import { acpInboxHandler } from "./handlers/acp-inbox";
import { mountAcpPerSidRoutes } from "./handlers/acp-per-sid";
import { mountSessionsRoutes } from "./handlers/sessions";
import { mountDirectoriesRoutes } from "./handlers/directories";
import { mountSkillsRoutes } from "../skills/routes";
import { mountOakridgeProxyRoutes, parseFallbackRefreshMs } from "./handlers/oakridge-proxy";
import { mountLiveStreamRoutes } from "./handlers/live-stream";
import {
  isRuntimeId,
  RUNTIME_EFFORTS,
  RUNTIME_MODELS,
} from "../runtime";

export interface CreateAppDeps {
  /** ACP session service — the production session backend. */
  acp: AcpSessionService;
  /** Optional server default workdir (from --workdir CLI arg). */
  defaultWorkdir: string | null;
  /** Path to the built PWA dist directory served as static files. */
  pwaDistDir: string;
  /**
   * Returns the Bun server instance for `requestIP` loopback verification
   * inside the runtime's hook handler. Must be a getter (not the value)
   * because bunServer is assigned after Bun.serve(), which happens after
   * this call.
   */
  getBunServer: () => import("bun").Server<unknown> | null;
  /** The server's validated config. */
  config: KbblConfig;
  /**
   * Startup auth policy resolved from host + OAKRIDGE_CONTROL_TOKEN +
   * ALLOW_INSECURE_NON_LOOPBACK_CONTROL. Defaults to loopback when absent.
   */
  authPolicy?: AuthPolicy;
  /**
   * Token injected into proxied Oakridge backend write requests.
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
    acp,
    defaultWorkdir,
    pwaDistDir,
    config,
    authPolicy = { mode: "loopback" },
    coreControlToken,
  } = deps;
  const app = new Hono();

  // ---- control auth middleware ----
  //
  // Applied globally before any route so every non-GET/HEAD request other
  // than /hook/* adapter routes requires authentication when the server is
  // configured with a control token, on any bind. Without one (loopback or
  // insecure mode) this is a no-op pass-through.
  app.use("/*", makeControlAuthMiddleware(authPolicy));

  // ---- cookie establishment endpoint ----
  //
  // POST /auth/cookie validates a Bearer token and sets an HttpOnly
  // SameSite=Lax cookie so the browser PWA can make subsequent control
  // calls without re-sending the token as a header (which would require
  // storing it in JS-accessible state).
  app.post("/auth/cookie", makeCookieHandler(authPolicy));
  app.get("/auth/status", makeAuthStatusHandler(authPolicy));

  // ---- ACP per-session routes (§14) ----
  mountAcpPerSidRoutes(app, { acp });

  // ---- per-session skills (app-owned sources over the ACP backend;
  // agent slash commands reach the PWA via `commands` UI events) ----
  mountSkillsRoutes(app, { acp, config });

  // ---- server config ----
  //
  // Exposes the operator-configured defaults the PWA needs to render forms.
  app.get("/config", (c) => {
    // A launch form exists before an ACP session can report config options,
    // so built-in profiles need a launch catalog. After session creation the
    // agent-reported ACP config options remain authoritative.
    return c.json({
      defaultWorkdir,
      defaultRuntimeId: acp.defaultAgent,
      runtimes: acp
        .listProfiles()
        .filter((profile) => profile.enabled)
        .map((profile) => {
          if (!isRuntimeId(profile.id)) {
            return {
              id: profile.id,
              label: profile.label,
              models: [],
              efforts: [],
            };
          }
          return {
            id: profile.id,
            label: profile.label,
            models: RUNTIME_MODELS[profile.id],
            efforts: RUNTIME_EFFORTS[profile.id],
          };
        }),
    });
  });



  // ---- sessions CRUD ----
  mountSessionsRoutes(app, { acp, defaultWorkdir, oakridgeBaseUrl: process.env.OAKRIDGE_CORE_BASE_URL, oakridgeControlToken: coreControlToken });

  // ---- local directory browser ----
  mountDirectoriesRoutes(app, { defaultWorkdir });


  // ---- Oakridge backend proxy ----
  //
  // GET /oakridge/config → { available, core_url, fallback_refresh_ms? } (PWA availability check)
  // ALL /oakridge/api/* → proxied to OAKRIDGE_CORE_BASE_URL (same-origin CORS avoidance)
  // Write requests are validated against kbbl auth (via the global middleware
  // above) before reaching this handler; the handler then injects the core
  // control token the Oakridge backend's operator routes require.
  mountOakridgeProxyRoutes(app, {
    baseUrl: process.env.OAKRIDGE_CORE_BASE_URL,
    coreControlToken,
    browserControlToken: authPolicy.mode === "token" ? authPolicy.token : undefined,
    fallbackRefreshMs: parseFallbackRefreshMs(process.env.OAKRIDGE_FALLBACK_REFRESH_MS),
  });

  // ---- /inbox (always-on snapshot stream over the ACP session list) ----
  app.get("/inbox", acpInboxHandler(acp));
  mountLiveStreamRoutes(app);

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
