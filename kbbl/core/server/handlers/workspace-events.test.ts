import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { mountWorkspaceEventsRoutes } from "./workspace-events";

function makeApp(): Hono {
  const app = new Hono();
  mountWorkspaceEventsRoutes(app);
  return app;
}

describe("POST /inbox/workspace-events", () => {
  test("accepts a well-formed workspace event", async () => {
    const app = makeApp();

    const res = await app.request("/inbox/workspace-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: " proposal_applied ",
        projectId: " p-1 ",
        ts: "2026-05-23T00:00:00.000Z",
        payload: { proposal_id: "prop-1" },
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("rejects blank project ids", async () => {
    const app = makeApp();

    const res = await app.request("/inbox/workspace-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "x", projectId: "   " }),
    });

    expect(res.status).toBe(400);
  });

  test("rejects blank kind", async () => {
    const app = makeApp();

    const res = await app.request("/inbox/workspace-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "   ", projectId: "p-1" }),
    });

    expect(res.status).toBe(400);
  });

  test("rejects a non-object payload", async () => {
    const app = makeApp();

    const res = await app.request("/inbox/workspace-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "x", projectId: "p-1", payload: "nope" }),
    });

    expect(res.status).toBe(400);
  });

  test("rejects invalid json", async () => {
    const app = makeApp();

    const res = await app.request("/inbox/workspace-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(400);
  });
});
