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
});
