import type { Hono } from "hono";

import {
  type SessionManager,
  type ProjectId,
  type WorkspaceEvent,
  type WorkspaceEventPayload,
} from "../../session/session-manager";

export interface WorkspaceEventsRouteDeps {
  manager: SessionManager;
}

interface WorkspaceEventRequestBody {
  kind?: unknown;
  projectId?: unknown;
  ts?: unknown;
  payload?: unknown;
}

function isWorkspaceEventRequestBody(
  value: unknown,
): value is WorkspaceEventRequestBody {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWorkspaceEventPayload(
  value: unknown,
): WorkspaceEventPayload | null {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) return null;
  return value as WorkspaceEventPayload;
}

function parseProjectId(value: unknown): ProjectId | null {
  const projectId = typeof value === "string" ? value.trim() : "";
  return projectId === "" ? null : (projectId as ProjectId);
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
    if (!isWorkspaceEventRequestBody(raw)) {
      return c.json({ error: "json body must be an object" }, 400);
    }
    const parsed = raw;
    // Trim before the empty check so whitespace-only values are rejected
    // too — matches the artifact_id handling in handlers/sessions.ts and
    // keeps subscribers from receiving events they can't meaningfully
    // filter on.
    const kind =
      typeof parsed.kind === "string" ? parsed.kind.trim() : "";
    if (kind === "") {
      return c.json({ error: "kind must be a non-empty string" }, 400);
    }
    const projectId = parseProjectId(parsed.projectId);
    if (projectId === null) {
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
    const payload = parseWorkspaceEventPayload(parsed.payload);
    if (payload === null) {
      return c.json(
        { error: "payload must be an object when provided" },
        400,
      );
    }
    const event: WorkspaceEvent = {
      kind,
      projectId,
      ts,
      payload,
    };
    manager.broadcastWorkspaceEvent(event);
    return c.json({ ok: true });
  });
}
