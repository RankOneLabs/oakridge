import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { matchRoute } from "../../../../oakridge-dbos/src/http/routes";
import { browserWritePolicy, browserWriteRejection, configuredBrowserWritePolicy } from "../../../../oakridge-dbos/src/http/browser-write-policy";
import { isValidControlToken } from "../../../../oakridge-dbos/src/http/control-auth";

export interface OakridgeProxyDeps {
  baseUrl: string | undefined;
  /**
   * Token injected as Authorization: Bearer <token> into operator routes
   * on the Oakridge backend. Falls back to OAKRIDGE_CONTROL_TOKEN when
   * OAKRIDGE_CORE_CONTROL_TOKEN is not set. Undefined when no token is
   * configured (core runs without auth, typically on a loopback bind).
   */
  coreControlToken?: string;
  /** Explicit browser origins; an absent list trusts none, including loopback. */
  allowedOrigins?: readonly string[];
  /**
   * Fallback refresh interval served to the PWA, in milliseconds. Undefined
   * leaves the PWA on its build-time default. The PWA enforces its own minimum
   * interval, so a value below it is ignored there rather than rejected here.
   */
  fallbackRefreshMs?: number;
}

/**
 * Parses OAKRIDGE_FALLBACK_REFRESH_MS at startup so a typo surfaces as a boot
 * failure rather than as an operator interval that silently never took effect.
 */
export function parseFallbackRefreshMs(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`OAKRIDGE_FALLBACK_REFRESH_MS must be a positive number of milliseconds, got: ${raw}`);
  return value;
}

const OAKRIDGE_PROXY_TIMEOUT_MS = 30_000;

/**
 * Upstream paths that stream indefinitely. A request deadline severs these
 * mid-stream, so they get none — `server.ts` already exempts the same path from
 * Bun's idle timeout, and an exemption on one hop is worthless while the other
 * hop still aborts at 30s. The upstream sends heartbeat comments, so a genuinely
 * dead connection is still detected by the socket, not by a timer here.
 */
const STREAMING_UPSTREAM_PATHS: ReadonlySet<string> = new Set(["/events"]);

export function mountOakridgeProxyRoutes(app: Hono, deps: OakridgeProxyDeps): void {
  const write_policy = deps.allowedOrigins === undefined ? configuredBrowserWritePolicy() : browserWritePolicy(deps.allowedOrigins);
  // Config: tells the PWA whether the Oakridge backend is configured without
  // attempting a proxy request that would block the page.
  app.get("/oakridge/config", (c) => {
    const available = typeof deps.baseUrl === "string" && deps.baseUrl.length > 0;
    return c.json({ available, core_url: available ? deps.baseUrl : null,
      ...(deps.fallbackRefreshMs === undefined ? {} : { fallback_refresh_ms: deps.fallbackRefreshMs }) });
  });

  app.use("/oakridge/api/*", bodyLimit({ maxSize: 1_048_576, onError: (c) => c.json({ kind: "oversized_payload", limit: 1_048_576 }, 413) }));

  // Proxy: forwards /oakridge/api/* to OAKRIDGE_CORE_BASE_URL/*
  // stripping the /oakridge/api prefix before forwarding.
  app.all("/oakridge/api/*", async (c) => {
    if (!deps.baseUrl) {
      return c.json({ error: "oakridge_unconfigured" }, 503);
    }

    const subPath = c.req.path.slice("/oakridge/api".length);
    const rejection = browserWriteRejection(write_policy, c.req.raw, subPath);
    if (rejection) return rejection;
    const route = matchRoute(c.req.method, subPath);
    if (route?.authority === "operator" && deps.coreControlToken && !isValidControlToken(c.req.header("authorization"), deps.coreControlToken))
      return c.json({ error: "unauthorized" }, 401);
    const search = new URL(c.req.url, "http://localhost").search;
    const targetUrl = deps.baseUrl.replace(/\/$/, "") + subPath + search;

    const method = c.req.method;
    // Only forward safe, non-sensitive headers. Strip credentials (cookie,
    // authorization) and hop-by-hop headers (connection, transfer-encoding,
    // upgrade, keep-alive, proxy-*) so kbbl session material is never leaked
    // to the Oakridge upstream. The retained core control token is then
    // injected server-side without the browser ever seeing the secret.
    const BLOCKED_HEADERS = new Set([
      "host", "content-length", "cookie",
      "connection", "transfer-encoding", "upgrade", "keep-alive",
      "proxy-authorization", "proxy-authenticate", "te", "trailer",
    ]);
    const forwardHeaders = new Headers();
    for (const [k, v] of Object.entries(c.req.header())) {
      if (!BLOCKED_HEADERS.has(k.toLowerCase())) {
        forwardHeaders.set(k, v as string);
      }
    }

    // Inject core control token for operator routes. The browser Authorization
    // header was stripped above; this is the server-side injection point.
    // Forward the supplied credential after enforcing the same operator check as the backend.

    let body: ArrayBuffer | undefined;
    if (method !== "GET" && method !== "HEAD") {
      body = await c.req.arrayBuffer();
    }

    try {
      const upstream = await fetch(targetUrl, {
        method,
        headers: forwardHeaders,
        body,
        signal: STREAMING_UPSTREAM_PATHS.has(subPath) ? undefined : AbortSignal.timeout(OAKRIDGE_PROXY_TIMEOUT_MS),
      });
      const ct = upstream.headers.get("content-type") ?? "application/json";
      const responseHeaders = new Headers({ "content-type": ct });
      // Streams must not be cached anywhere on the way back to the browser;
      // the upstream says so and dropping the header would lose that.
      const cacheControl = upstream.headers.get("cache-control");
      if (cacheControl) responseHeaders.set("cache-control", cacheControl);
      return new Response(upstream.body, {
        status: upstream.status,
        headers: responseHeaders,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `oakridge upstream unreachable: ${msg}` }, 502);
    }
  });
}
