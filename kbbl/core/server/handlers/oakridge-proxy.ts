import type { Hono } from "hono";

export interface OakridgeProxyDeps {
  baseUrl: string | undefined;
}

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
    const forwardHeaders = new Headers();
    for (const [k, v] of Object.entries(c.req.header())) {
      const lower = k.toLowerCase();
      if (lower !== "host" && lower !== "content-length") {
        forwardHeaders.set(k, v as string);
      }
    }

    let body: ArrayBuffer | undefined;
    if (method !== "GET" && method !== "HEAD") {
      body = await c.req.arrayBuffer();
    }

    try {
      const upstream = await fetch(targetUrl, { method, headers: forwardHeaders, body });
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
