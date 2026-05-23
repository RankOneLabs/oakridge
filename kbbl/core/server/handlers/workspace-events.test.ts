import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import type { ProjectId, SessionManager, WorkspaceEvent } from "../../session/session-manager";
import { mountWorkspaceEventsRoutes } from "./workspace-events";

function makeApp(captured: WorkspaceEvent[]): Hono {
  const app = new Hono();
  mountWorkspaceEventsRoutes(app, {
    manager: {
      broadcastWorkspaceEvent(event: WorkspaceEvent): void {
        captured.push(event);
      },
    } as SessionManager,
  });
  return app;
}

describe("POST /inbox/workspace-events", () => {
  test("trims and broadcasts a typed workspace event", async () => {
    const captured: WorkspaceEvent[] = [];
    const app = makeApp(captured);

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
    expect(captured).toEqual([
      {
        kind: "proposal_applied",
        projectId: "p-1" as ProjectId,
        ts: "2026-05-23T00:00:00.000Z",
        payload: { proposal_id: "prop-1" },
      },
    ]);
  });

  test("rejects blank project ids", async () => {
    const captured: WorkspaceEvent[] = [];
    const app = makeApp(captured);

    const res = await app.request("/inbox/workspace-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "x", projectId: "   " }),
    });

    expect(res.status).toBe(400);
    expect(captured).toEqual([]);
  });
});
