import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { mountOakridgeProxyRoutes, parseFallbackRefreshMs } from "./oakridge-proxy";
import { HTTP_ROUTES } from "../../../../oakridge-dbos/src/http/routes";
import { browserWriteMiddleware, browserWritePolicy } from "../../../../oakridge-dbos/src/http/browser-write-policy";
import { controlTokenMiddleware } from "../../../../oakridge-dbos/src/http/control-auth";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("oakridge proxy", () => {
  test("the direct and proxy paths reject every table write with non-JSON content or an unlisted origin", async () => {
    const direct = new Hono();
    direct.use("*", browserWriteMiddleware(browserWritePolicy(["https://operator.example"])));
    direct.use("*", controlTokenMiddleware("shared-token"));
    direct.all("*", (c) => c.json({ accepted: true }));
    const proxy = new Hono();
    mountOakridgeProxyRoutes(proxy, { baseUrl: "http://oakridge.test", allowedOrigins: ["https://operator.example"],
      browserControlToken: "shared-token", coreControlToken: "shared-token" });
    for (const route of HTTP_ROUTES.filter((item) => item.method !== "GET")) {
      const path = route.path.replace(/:[^/]+/g, "id");
      for (const [headers, status] of [
        [new Headers({ "content-type": "text/plain", authorization: "Bearer shared-token" }), 415],
        [new Headers({ "content-type": "application/json", origin: "http://127.0.0.1:5173", authorization: "Bearer shared-token" }), 403],
      ] as const) {
        const options = { method: route.method, headers, body: "{}" };
        expect((await direct.request(path, options)).status).toBe(status);
        expect((await proxy.request(`/oakridge/api${path}`, options)).status).toBe(status);
      }
    }
    const authorized = { method: "POST", headers: { "content-type": "application/json", origin: "https://operator.example", authorization: "Bearer shared-token" }, body: "{}" };
    expect((await direct.request("/runs", authorized)).status).toBe(200);
    expect((await direct.request("/runs", { ...authorized, headers: { ...authorized.headers, authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await proxy.request("/oakridge/api/runs", { ...authorized, headers: { ...authorized.headers, authorization: "Bearer wrong" } })).status).toBe(401);
  });

  test("a control cookie authenticates the PWA on both paths and stays off the upstream wire", async () => {
    const policy = browserWritePolicy(["https://operator.example"]);
    const direct = new Hono();
    direct.use("*", browserWriteMiddleware(policy));
    direct.use("*", controlTokenMiddleware("shared-token", policy));
    direct.all("*", (c) => c.json({ accepted: true }));
    let upstream_authorization: string | null = null;
    globalThis.fetch = (async (_input, init) => {
      upstream_authorization = (init?.headers as Headers).get("authorization");
      expect((init?.headers as Headers).get("cookie")).toBeNull();
      return Response.json({ accepted: true });
    }) as typeof fetch;
    const proxy = new Hono();
    mountOakridgeProxyRoutes(proxy, { baseUrl: "http://oakridge.test", browserControlToken: "shared-token",
      coreControlToken: "shared-token", allowedOrigins: ["https://operator.example"] });
    const request = { method: "POST", headers: { "content-type": "application/json", origin: "https://operator.example",
      cookie: "kbbl_ctrl=shared-token" }, body: "{}" };
    expect((await direct.request("/runs", request)).status).toBe(200);
    expect((await proxy.request("/oakridge/api/runs", request)).status).toBe(200);
    expect(String(upstream_authorization)).toBe("Bearer shared-token");
    expect((await direct.request("/runs", { headers: { cookie: "kbbl_ctrl=shared-token" } })).status).toBe(200);
    expect((await proxy.request("/oakridge/api/runs", { headers: { cookie: "kbbl_ctrl=shared-token" } })).status).toBe(200);
    expect((await direct.request("/runs", { ...request, headers: { ...request.headers, origin: "http://127.0.0.1:5173" } })).status).toBe(403);
    expect((await proxy.request("/oakridge/api/runs", { ...request, headers: { ...request.headers, origin: "http://127.0.0.1:5173" } })).status).toBe(403);
    const no_origin = { ...request, headers: { "content-type": "application/json", cookie: "kbbl_ctrl=shared-token" } };
    expect((await direct.request("/runs", no_origin)).status).toBe(401);
    expect((await proxy.request("/oakridge/api/runs", no_origin)).status).toBe(401);
    expect((await direct.request("/runs", { ...request, headers: { ...request.headers, cookie: "kbbl_ctrl=wrong" } })).status).toBe(401);
    expect((await proxy.request("/oakridge/api/runs", { ...request, headers: { ...request.headers, cookie: "kbbl_ctrl=wrong" } })).status).toBe(401);
  });
  test("serves the operator refresh interval so it is settable without a PWA rebuild", async () => {
    const app = new Hono();
    mountOakridgeProxyRoutes(app, { baseUrl: "http://oakridge.test", fallbackRefreshMs: 5_000 });
    expect(await (await app.request("/oakridge/config")).json()).toEqual({
      available: true, core_url: "http://oakridge.test", fallback_refresh_ms: 5_000 });
  });

  test("states no interval when none is configured, leaving the PWA default in place", async () => {
    const app = new Hono();
    mountOakridgeProxyRoutes(app, { baseUrl: "http://oakridge.test" });
    expect(await (await app.request("/oakridge/config")).json()).toEqual({ available: true, core_url: "http://oakridge.test" });
  });

  test("an unset refresh interval is absent, not a value", () => {
    expect([parseFallbackRefreshMs(undefined), parseFallbackRefreshMs("  ")]).toEqual([undefined, undefined]);
  });

  test("a configured refresh interval parses to its millisecond value", () => {
    expect(parseFallbackRefreshMs("5000")).toBe(5_000);
  });

  test("the largest timer delay is still accepted", () => {
    expect(parseFallbackRefreshMs("2147483647")).toBe(2_147_483_647);
  });

  test.each(["soon", "0", "-1", "2147483648", "1e12"])("a refresh interval of %s fails the boot rather than being ignored", (raw) => {
    expect(() => parseFallbackRefreshMs(raw)).toThrow(/OAKRIDGE_FALLBACK_REFRESH_MS/);
  });

  test("preserves a durable ingress receipt and the upstream acceptance status", async () => {
    let target = "";
    globalThis.fetch = (async (input, init) => {
      target = String(input);
      expect(init?.method).toBe("POST");
      return Response.json({ kind: "accepted_pending", request_id: "request-1", transition_id: "transition-1", scope_version: 5 }, { status: 202 });
    }) as typeof fetch;
    const app = new Hono();
    mountOakridgeProxyRoutes(app, { baseUrl: "http://oakridge.test" });
    const response = await app.request("/oakridge/api/runs/run-1/scopes/scope-1/commands", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect({ target, status: response.status, body: await response.json() }).toEqual({
      target: "http://oakridge.test/runs/run-1/scopes/scope-1/commands", status: 202,
      body: { kind: "accepted_pending", request_id: "request-1", transition_id: "transition-1", scope_version: 5 },
    });
  });

  test("preserves an unsupported upstream ingress failure", async () => {
    globalThis.fetch = (async () => Response.json({ error: "unsupported_ingress" }, { status: 501 })) as unknown as typeof fetch;
    const app = new Hono();
    mountOakridgeProxyRoutes(app, { baseUrl: "http://oakridge.test" });
    const response = await app.request("/oakridge/api/unsupported", { method: "POST", body: "{}" });
    expect({ status: response.status, body: await response.json() }).toEqual({ status: 501, body: { error: "unsupported_ingress" } });
  });

  test("bounds upstream fetches with an abort signal", async () => {
    let signal: AbortSignal | undefined;
    globalThis.fetch = (async (_input, init) => {
      signal = init?.signal instanceof AbortSignal ? init.signal : undefined;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const app = new Hono();
    mountOakridgeProxyRoutes(app, { baseUrl: "http://oakridge.test" });

    const res = await app.request("/oakridge/api/runs");
    expect(res.status).toBe(200);
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  test("requires kbbl's own control token on operator requests, then presents the core token upstream", async () => {
    const captured = { authHeader: null as string | null };
    globalThis.fetch = (async (_input, init) => {
      const headers = init?.headers as Headers | undefined;
      captured.authHeader = headers?.get("authorization") ?? null;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const app = new Hono();
    mountOakridgeProxyRoutes(app, {
      baseUrl: "http://oakridge.test",
      browserControlToken: "kbbl-token",
      coreControlToken: "core-secret",
    });

    expect((await app.request("/oakridge/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    await app.request("/oakridge/api/runs", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer kbbl-token" }, body: "{}" });
    expect(captured.authHeader).toBe("Bearer core-secret");
  });

  // The documented OAKRIDGE_CORE_CONTROL_TOKEN override makes kbbl's browser
  // credential and the upstream's credential two different strings. Checking
  // the browser against the upstream token rejected every proxied operator
  // request; a single shared token in every other case hides that entirely.
  test("a differing core token override leaves the PWA's own credential working on operator reads and writes", async () => {
    const forwarded: (string | null)[] = [];
    globalThis.fetch = (async (_input, init) => {
      const headers = init?.headers as Headers;
      expect(headers.get("cookie")).toBeNull();
      forwarded.push(headers.get("authorization"));
      return Response.json({ ok: true });
    }) as typeof fetch;
    const app = new Hono();
    mountOakridgeProxyRoutes(app, { baseUrl: "http://oakridge.test", allowedOrigins: ["https://operator.example"],
      browserControlToken: "kbbl-token", coreControlToken: "core-secret" });
    const cookie = { cookie: "kbbl_ctrl=kbbl-token" };
    expect((await app.request("/oakridge/api/api/runs", { headers: cookie })).status).toBe(200);
    expect((await app.request("/oakridge/api/runs", { method: "POST", body: "{}",
      headers: { ...cookie, "content-type": "application/json", origin: "https://operator.example" } })).status).toBe(200);
    // Every upstream hop carries the core token, never kbbl's.
    expect(forwarded).toEqual(["Bearer core-secret", "Bearer core-secret"]);
    // The upstream credential is not a browser credential: presenting it fails.
    expect((await app.request("/oakridge/api/runs", { method: "POST", body: "{}",
      headers: { "content-type": "application/json", origin: "https://operator.example", authorization: "Bearer core-secret" } })).status).toBe(401);
  });

  test("table operator routes forward the supplied control token", async () => {
    const received: (string | null)[] = [];
    globalThis.fetch = (async (_input, init) => {
      received.push((init?.headers as Headers).get("authorization"));
      return Response.json({ ok: true });
    }) as typeof fetch;
    const app = new Hono();
    mountOakridgeProxyRoutes(app, { baseUrl: "http://oakridge.test", browserControlToken: "kbbl-token", coreControlToken: "core-secret" });
    for (const route of HTTP_ROUTES) {
      const path = route.path.replace(/:[^/]+/g, "id");
      await app.request(`/oakridge/api${path}`, { method: route.method,
        headers: { authorization: route.authority === "operator" ? "Bearer kbbl-token" : "", "content-type": "application/json" },
        body: route.method === "GET" ? undefined : "{}" });
    }
    // Operator routes carry the injected core token; everything else reaches the
    // upstream with no Authorization at all, the browser's header having been
    // stripped rather than passed through.
    expect(received).toEqual(HTTP_ROUTES.map((route) => route.authority === "operator" ? "Bearer core-secret" : null));
  });

  test("a two MiB request returns a typed 413 before proxy buffering", async () => {
    const app = new Hono();
    mountOakridgeProxyRoutes(app, { baseUrl: "http://oakridge.test" });
    const response = await app.request("/oakridge/api/runs", { method: "POST", body: "x".repeat(2 * 1024 * 1024) });
    expect({ status: response.status, body: await response.json() }).toEqual({ status: 413, body: { kind: "oversized_payload", limit: 1_048_576 } });
  });

  test("does not inject core token on GET requests", async () => {
    const captured = { authHeader: null as string | null };
    globalThis.fetch = (async (_input, init) => {
      const headers = init?.headers as Headers | undefined;
      captured.authHeader = headers?.get("authorization") ?? null;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const app = new Hono();
    mountOakridgeProxyRoutes(app, {
      baseUrl: "http://oakridge.test",
      coreControlToken: "core-secret",
    });

    await app.request("/oakridge/api/workflow_runs");
    expect(captured.authHeader).toBeNull();
  });

  test("strips any browser authorization header before forwarding", async () => {
    const captured = { authHeader: null as string | null };
    globalThis.fetch = (async (_input, init) => {
      const headers = init?.headers as Headers | undefined;
      captured.authHeader = headers?.get("authorization") ?? null;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const app = new Hono();
    // No coreControlToken — we just verify the browser header is stripped.
    mountOakridgeProxyRoutes(app, { baseUrl: "http://oakridge.test" });

    // A JSON content type is required, or the write policy rejects this with a
    // 415 before any fetch and the assertion below passes without the proxy
    // having forwarded anything at all.
    const response = await app.request("/oakridge/api/runs", {
      method: "POST",
      headers: { authorization: "Bearer browser-token", "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(captured.authHeader).toBeNull();
  });

  test("ties the unbounded invalidation stream to client cancellation", async () => {
    const captured: { signal: AbortSignal | null | undefined } = { signal: null };
    globalThis.fetch = (async (_input, init) => {
      captured.signal = init?.signal;
      return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    const app = new Hono();
    mountOakridgeProxyRoutes(app, { baseUrl: "http://oakridge.test" });

    const controller = new AbortController();
    await app.request("/oakridge/api/events", { signal: controller.signal });
    controller.abort();
    expect(captured.signal?.aborted).toBe(true);
  });

  test("forwards the stream's no-cache directive instead of dropping it", async () => {
    globalThis.fetch = (async (_input, _init) =>
      new Response("", { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })) as typeof fetch;

    const app = new Hono();
    mountOakridgeProxyRoutes(app, { baseUrl: "http://oakridge.test" });

    const res = await app.request("/oakridge/api/events");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  test("forwards the client's last event id so a reconnect can resume", async () => {
    const captured = { lastEventId: null as string | null };
    globalThis.fetch = (async (_input, init) => {
      const headers = init?.headers as Headers | undefined;
      captured.lastEventId = headers?.get("last-event-id") ?? null;
      return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    const app = new Hono();
    mountOakridgeProxyRoutes(app, { baseUrl: "http://oakridge.test" });

    await app.request("/oakridge/api/events", { headers: { "last-event-id": "cursor-7" } });
    expect(captured.lastEventId).toBe("cursor-7");
  });
});
