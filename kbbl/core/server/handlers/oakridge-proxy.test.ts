import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { mountOakridgeProxyRoutes } from "./oakridge-proxy";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("oakridge proxy", () => {
  test("preserves a durable ingress receipt and the upstream acceptance status", async () => {
    let target = "";
    globalThis.fetch = (async (input, init) => {
      target = String(input);
      expect(init?.method).toBe("POST");
      return Response.json({ kind: "accepted_pending", request_id: "request-1", transition_id: "transition-1", scope_version: 5 }, { status: 202 });
    }) as typeof fetch;
    const app = new Hono();
    mountOakridgeProxyRoutes(app, { baseUrl: "http://oakridge.test" });
    const response = await app.request("/oakridge/api/runs/run-1/scopes/scope-1/commands", { method: "POST", body: "{}" });
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

  test("leaves the invalidation stream unbounded so the deadline cannot sever it", async () => {
    let signal: AbortSignal | null | undefined = null;
    globalThis.fetch = (async (_input, init) => {
      signal = init?.signal;
      return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    const app = new Hono();
    mountOakridgeProxyRoutes(app, { baseUrl: "http://oakridge.test" });

    await app.request("/oakridge/api/events");
    expect(signal).toBeUndefined();
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
