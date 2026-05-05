import type { Hono } from "hono";

import {
  type SessionManager,
  type WorkspaceEvent,
} from "../../session/session-manager";

export interface WorkspaceEventsRouteDeps {
  manager: SessionManager;
}

/**
 * Registers `POST /inbox/workspace-events` on the given Hono app.
 *
 * The workspace layer (legit-biz-club) posts project lifecycle and
 * coordination events to this endpoint; kbbl re-broadcasts them to
 * inbox SSE subscribers as `workspace_event` deltas without
 * interpreting the payload. This is the only kbbl-side coupling point
 * for workspace events — adding new event kinds at the workspace
 * layer does not require kbbl changes.
 *
 * Trust: same Tailscale-network model as the rest of kbbl. The route
 * does no auth beyond requiring a non-empty kind + projectId on the
 * body. legit-biz-club is expected to be a trusted local caller.
 */
export function mountWorkspaceEventsRoutes(
  app: Hono,
  deps: WorkspaceEventsRouteDeps,
): void {
  const { manager } = deps;

  app.post("/inbox/workspace-events", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    // Reject non-object bodies explicitly. Property access on arrays /
    // strings / numbers silently yields undefined, which would slip a
    // misshapen body through as a no-op broadcast and mask client bugs.
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return c.json({ error: "json body must be an object" }, 400);
    }
    const parsed = raw as {
      kind?: unknown;
      projectId?: unknown;
      ts?: unknown;
      payload?: unknown;
    };
    if (typeof parsed.kind !== "string" || parsed.kind === "") {
      return c.json({ error: "kind must be a non-empty string" }, 400);
    }
    if (typeof parsed.projectId !== "string" || parsed.projectId === "") {
      return c.json({ error: "projectId must be a non-empty string" }, 400);
    }
    // Default the timestamp to receipt time if the emitter omitted it.
    // Kbbl is the central clock for inbox sequencing anyway, and a
    // missing ts is more likely a client oversight than a deliberate
    // signal — a sane default beats rejecting on a recoverable shape.
    const ts =
      typeof parsed.ts === "string" && parsed.ts !== ""
        ? parsed.ts
        : new Date().toISOString();
    // Default payload to empty object only when it's omitted (or
    // explicitly null) so subscribers can dereference ``event.payload``
    // without null-checking. If it's PRESENT but malformed (string,
    // number, array), reject 400 instead of silently coercing — silent
    // coercion would tell the caller the broadcast succeeded while
    // dropping the event details, masking client bugs and leaving
    // workspace-event consumers without the coordination metadata.
    let payload: Record<string, unknown>;
    if (parsed.payload === undefined || parsed.payload === null) {
      payload = {};
    } else if (
      typeof parsed.payload !== "object" ||
      Array.isArray(parsed.payload)
    ) {
      return c.json(
        { error: "payload must be an object when provided" },
        400,
      );
    } else {
      payload = parsed.payload as Record<string, unknown>;
    }
    const event: WorkspaceEvent = {
      kind: parsed.kind,
      projectId: parsed.projectId,
      ts,
      payload,
    };
    manager.broadcastWorkspaceEvent(event);
    return c.json({ ok: true });
  });
}
