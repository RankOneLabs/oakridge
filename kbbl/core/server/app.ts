import { sharedProfileReadiness, type AgentProfileReadiness } from "../acp/profile-readiness";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { compress } from "hono/compress";

import type { KbblConfig } from "../config";
import type { AcpSessionService } from "../acp/session-service";
import {
  KBBL_PUBLIC_PATHS,
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
import { compressEventStream } from "./event-stream-compression";
import { mountHealthRoutes, type ObservationServerConfig } from "./handlers/observation-health";
import { mountObservationProxyRoutes } from "./handlers/observation-proxy";
import { mountExecutedPromptRoutes } from "./handlers/executed-prompt";
import {
  isRuntimeId,
  RUNTIME_EFFORTS,
} from "../runtime";

export interface CreateAppDeps {
  readonly defaultPrIntegration?: import("../../../oakridge-dbos/src/domain/pr-integration").PrIntegration;
  readonly readAgentProfiles?: () => Promise<readonly AgentProfileReadiness[]>;
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
  /** The observation service and its server-held capabilities; null or absent when it is not deployed. */
  observation?: ObservationServerConfig | null;
}

/** Constructs the Hono app with auth middleware before every route and the static PWA handler last. */
export function createApp(deps: CreateAppDeps): Hono {
  const {
    acp,
    defaultWorkdir,
    pwaDistDir,
    config,
    authPolicy = { mode: "loopback" },
    coreControlToken,
    observation = null,
  } = deps;
  const app = new Hono();
  const readAgentProfiles = deps.readAgentProfiles ? sharedProfileReadiness({ read: deps.readAgentProfiles }) : null;

  // ---- response compression ----
  //
  // Skips event streams, which it would buffer forever; /live has its own.
  app.use("/*", compress());
  app.use("/live", compressEventStream);

  // ---- control auth middleware ----
  //
  // On any bind with a control token, every request requires a Bearer token
  // or the kbbl_ctrl cookie except GET/HEAD on the public allow-list
  // (/auth/status and the static PWA files). Without a token, loopback and
  // insecure modes pass through.
  app.use("/*", makeControlAuthMiddleware(authPolicy, { publicPaths: KBBL_PUBLIC_PATHS }));

  // ---- cookie establishment endpoint ----
  //
  // POST /auth/cookie validates a Bearer token and sets an HttpOnly
  // SameSite=Lax cookie so the browser PWA can make subsequent control
  // calls without re-sending the token as a header (which would require
  // storing it in JS-accessible state).
  app.post("/auth/cookie", makeCookieHandler(authPolicy));
  app.get("/auth/status", makeAuthStatusHandler(authPolicy));

  // ---- health ----
  //
  // Mounted ahead of the per-session routes. Reports the observation component
  // beside kbbl's own availability: an observation outage degrades this answer
  // and never stops kbbl serving.
  mountHealthRoutes(app, { config: observation });

  // ---- ACP per-session routes (§14) ----
  mountAcpPerSidRoutes(app, { acp });
  mountExecutedPromptRoutes(app, { acp, browserControlToken: authPolicy.mode === "token" ? authPolicy.token : undefined });

  // ---- per-session skills (app-owned sources over the ACP backend;
  // agent slash commands reach the PWA via `commands` UI events) ----
  mountSkillsRoutes(app, { acp, config });

  app.get("/agent-profiles/readiness", async (c) => {
    if (!readAgentProfiles) return c.json({ error: "Profile readiness reader is not configured" }, 503);
    try { return c.json(await readAgentProfiles()); }
    catch { return c.json({ error: "Profile readiness probe failed" }, 503); }
  });

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
        .map((profile) => ({
          id: profile.id,
          label: profile.label,
          models: profile.models ?? [],
          default_model: profile.default_model ?? null,
          efforts: isRuntimeId(profile.id) ? RUNTIME_EFFORTS[profile.id] : [],
        })),
    });
  });



  // ---- sessions CRUD ----
  mountSessionsRoutes(app, { acp, defaultWorkdir, defaultPrIntegration: deps.defaultPrIntegration, oakridgeBaseUrl: process.env.OAKRIDGE_CORE_BASE_URL, oakridgeControlToken: coreControlToken });

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

  // ---- Observation forwarding ----
  //
  // /oakridge/observation/* → the listed reads and the one write, each with the
  // server-held capability it needs. An outage answers these routes and no other.
  mountObservationProxyRoutes(app, {
    observation,
    browserControlToken: authPolicy.mode === "token" ? authPolicy.token : undefined,
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
      // Vite hashes everything under assets/, so a changed file has a new URL.
      onFound: (path, c) => {
        c.header("cache-control", path.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
      },
    }),
  );

  return app;
}
