import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { mountOakridgeProxyRoutes } from "./oakridge-proxy";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("oakridge proxy", () => {
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

  test("injects core control token as Bearer on write requests", async () => {
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

    await app.request("/oakridge/api/workflow_runs", { method: "POST", body: "{}" });
    expect(captured.authHeader).toBe("Bearer core-secret");
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

    await app.request("/oakridge/api/runs", {
      method: "POST",
      headers: { authorization: "Bearer browser-token" },
      body: "{}",
    });
    expect(captured.authHeader).toBeNull();
  });
});
