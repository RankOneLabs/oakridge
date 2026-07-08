import type { Hono } from "hono";

export interface OakridgeProxyDeps {
  baseUrl: string | undefined;
}

const OAKRIDGE_PROXY_TIMEOUT_MS = 30_000;

export function mountOakridgeProxyRoutes(app: Hono, deps: OakridgeProxyDeps): void {
  // Config: tells the PWA whether oakridge-core is reachable without
  // attempting a proxy request that would block the page.
  app.get("/oakridge/config", (c) => {
    return c.json({ available: typeof deps.baseUrl === "string" && deps.baseUrl.length > 0 });
  });

  // Proxy: forwards /oakridge/api/* to OAKRIDGE_CORE_BASE_URL/*
  // stripping the /oakridge/api prefix before forwarding.
  app.all("/oakridge/api/*", async (c) => {
    if (!deps.baseUrl) {
      return c.json({ error: "oakridge_unconfigured" }, 503);
    }

    const subPath = c.req.path.slice("/oakridge/api".length);
    const search = new URL(c.req.url, "http://localhost").search;
    const targetUrl = deps.baseUrl.replace(/\/$/, "") + subPath + search;

    const method = c.req.method;
    // Only forward safe, non-sensitive headers. Strip credentials (cookie,
    // authorization) and hop-by-hop headers (connection, transfer-encoding,
    // upgrade, keep-alive, proxy-*) so kbbl session material is never leaked
    // to the oakridge-core upstream.
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

    let body: ArrayBuffer | undefined;
    if (method !== "GET" && method !== "HEAD") {
      body = await c.req.arrayBuffer();
    }

    try {
      const upstream = await fetch(targetUrl, {
        method,
        headers: forwardHeaders,
        body,
        signal: AbortSignal.timeout(OAKRIDGE_PROXY_TIMEOUT_MS),
      });
      const ct = upstream.headers.get("content-type") ?? "application/json";
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { "content-type": ct },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `oakridge upstream unreachable: ${msg}` }, 502);
    }
  });
}
