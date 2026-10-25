import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { matchRoute } from "../../../../oakridge-dbos/src/http/routes";
import { browserWritePolicy, browserWriteRejection, configuredBrowserWritePolicy } from "../../../../oakridge-dbos/src/http/browser-write-policy";
import { isValidControlRequest } from "../../../../oakridge-dbos/src/http/control-auth";
import { parseUnitViews } from "../../pwa/oakridge/adapters/parse";
import { parseUnitHistory, runActivityEvents, type UnitActivityHistory } from "../../pwa/oakridge/adapters/activity";
import { createTaggedReadCache } from "./oakridge-read-cache";

export interface OakridgeProxyDeps {
  baseUrl: string | undefined;
  /**
   * Token injected as Authorization: Bearer <token> into operator routes
   * on the Oakridge backend. Falls back to OAKRIDGE_CONTROL_TOKEN when
   * OAKRIDGE_CORE_CONTROL_TOKEN is not set. Undefined when no token is
   * configured (core runs without auth, typically on a loopback bind).
   */
  coreControlToken?: string;
  /**
   * kbbl's own control token — the value its `kbbl_ctrl` cookie carries and its
   * global middleware validates. Required for operator routes whenever
   * `coreControlToken` is set: without it they are refused. The browser is authenticated against THIS, not
   * against `coreControlToken`: the two differ whenever the documented
   * `OAKRIDGE_CORE_CONTROL_TOKEN` override is set, and checking the browser's
   * credential against the upstream's would reject every proxied operator
   * request. Undefined when kbbl runs without auth, which leaves the inbound
   * check to kbbl's policy exactly as the direct path does.
   */
  browserControlToken?: string;
  /** Explicit browser origins; an absent list trusts none, including loopback. */
  allowedOrigins?: readonly string[];
  /**
   * Fallback refresh interval served to the PWA, in milliseconds. Undefined
   * leaves the PWA on its build-time default. The PWA enforces its own minimum
   * interval, so a value below it is ignored there rather than rejected here.
   */
  fallbackRefreshMs?: number;
}

/** setInterval stores its delay as a signed 32-bit integer; a larger one fires roughly every millisecond. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Parses OAKRIDGE_FALLBACK_REFRESH_MS at startup so a typo surfaces as a boot
 * failure rather than as an operator interval that silently never took effect.
 */
export function parseFallbackRefreshMs(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS)
    throw new Error(`OAKRIDGE_FALLBACK_REFRESH_MS must be a positive number of milliseconds no greater than ${MAX_TIMER_DELAY_MS}, got: ${raw}`);
  return value;
}

const OAKRIDGE_PROXY_TIMEOUT_MS = 30_000;
/** The Activity pane's server-side reads poll the same keyed paths; most answer 304. */
const upstreamRead = createTaggedReadCache();

/**
 * Upstream paths that stream indefinitely. A request deadline severs these
 * mid-stream, so they get none — `server.ts` already exempts the same path from
 * Bun's idle timeout, and an exemption on one hop is worthless while the other
 * hop still aborts at 30s. The upstream sends heartbeat comments, so a genuinely
 * dead connection is still detected by the socket, not by a timer here.
 */
const STREAMING_UPSTREAM_PATHS: ReadonlySet<string> = new Set(["/events"]);

/** Serve the frozen Activity pane from v2's durable per-unit history. */
async function legacyRunEvents(baseUrl: string, headers: Headers, requestUrl: string): Promise<Response> {
  const query = new URL(requestUrl).searchParams;
  const runId = query.get("run_id");
  const limit = Number(query.get("limit") ?? "500");
  const after = query.get("after");
  if (!runId || !Number.isSafeInteger(limit) || limit < 1 || limit > 500 || (after !== null && !/^\d+$/.test(after)))
    return Response.json({ error: "invalid run activity query" }, { status: 400 });
  const unitPath = `/api/runs/${encodeURIComponent(runId)}/units`;
  const get = (path: string): Promise<Response> => upstreamRead(baseUrl.replace(/\/$/, "") + path, {
    headers, signal: AbortSignal.timeout(OAKRIDGE_PROXY_TIMEOUT_MS),
  });
  const unitsResponse = await get(unitPath);
  if (!unitsResponse.ok) return new Response(unitsResponse.body, { status: unitsResponse.status,
    headers: { "content-type": unitsResponse.headers.get("content-type") ?? "application/json" } });
  const units = parseUnitViews(await unitsResponse.json());
  if (!units.ok) return Response.json({ error: units.error.detail }, { status: 502 });
  const histories = await Promise.all(units.value.map(async (unit): Promise<UnitActivityHistory> => {
    const events: UnitActivityHistory["events"][number][] = [];
    let cursor: string | null = null;
    do {
      const path = `${unitPath}/${encodeURIComponent(unit.unit_id)}/history?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const response = await get(path);
      if (!response.ok) throw new Error(`unit history ${unit.unit_id}: ${response.status}`);
      const page = parseUnitHistory(await response.json());
      if (!page.ok || page.value.unit_id !== unit.unit_id) throw new Error(`unit history ${unit.unit_id}: invalid response`);
      events.push(...page.value.events);
      cursor = page.value.next_cursor;
    } while (cursor !== null);
    return { unit, events };
  }));
  const events = runActivityEvents(runId, histories);
  const first = after === null ? 0 : Number(after);
  return Response.json(events.slice(first, first + limit), { headers: { "cache-control": "no-store" } });
}

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
    const isLegacyRunEvents = c.req.method === "GET" && subPath === "/run_events";
    const route = matchRoute(c.req.method, subPath) ?? (isLegacyRunEvents
      ? { method: "GET" as const, path: subPath, authority: "operator" as const } : undefined);
    // The proxy presents the core token on the caller's behalf, so an operator
    // route needs kbbl's own credential whenever a core token is configured.
    // Without a browser token there is nothing to check the caller against,
    // and the proxy refuses rather than act as the operator for anyone.
    if (route?.authority === "operator" && (deps.browserControlToken
      ? !isValidControlRequest(c.req.raw, deps.browserControlToken, write_policy) : deps.coreControlToken !== undefined))
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
      "host", "content-length", "cookie", "authorization",
      "connection", "transfer-encoding", "upgrade", "keep-alive",
      "proxy-authorization", "proxy-authenticate", "te", "trailer",
    ]);
    const forwardHeaders = new Headers();
    for (const [k, v] of Object.entries(c.req.header())) {
      if (!BLOCKED_HEADERS.has(k.toLowerCase())) {
        forwardHeaders.set(k, v as string);
      }
    }

    // Inject the core control token for operator routes. The browser's own
    // Authorization header is stripped above rather than forwarded, so kbbl's
    // credential never reaches the upstream and cannot suppress this injection
    // by occupying the header. The PWA cookie likewise stays local to kbbl; a
    // verified browser credential is replaced here by the control token the
    // backend would have accepted directly.
    if (route?.authority === "operator" && deps.coreControlToken)
      forwardHeaders.set("authorization", `Bearer ${deps.coreControlToken}`);

    let body: ArrayBuffer | undefined;
    if (method !== "GET" && method !== "HEAD") {
      body = await c.req.arrayBuffer();
    }

    try {
      if (isLegacyRunEvents) return await legacyRunEvents(deps.baseUrl, forwardHeaders, c.req.url);
      const upstream = await fetch(targetUrl, {
        method,
        headers: forwardHeaders,
        body,
        signal: STREAMING_UPSTREAM_PATHS.has(subPath) ? c.req.raw.signal : AbortSignal.timeout(OAKRIDGE_PROXY_TIMEOUT_MS),
      });
      const ct = upstream.headers.get("content-type") ?? "application/json";
      const responseHeaders = new Headers({ "content-type": ct });
      // Streams must not be cached anywhere on the way back to the browser;
      // the upstream says so and dropping the header would lose that.
      const cacheControl = upstream.headers.get("cache-control");
      if (cacheControl) responseHeaders.set("cache-control", cacheControl);
      // The browser revalidates a keyed read with this tag and gets a bodiless 304 while it holds.
      const etag = upstream.headers.get("etag");
      if (etag) responseHeaders.set("etag", etag);
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
