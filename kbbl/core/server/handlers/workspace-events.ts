import type { Hono } from "hono";

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

function isValidPayload(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === "object" && !Array.isArray(value);
}

/**
 * Registers `POST /inbox/workspace-events` on the given Hono app.
 *
 * This legacy project-event shape has no run and scope identity required by
 * Oakridge's durable ingress. Reject it explicitly until the sender adopts a
 * supported ingress contract. A successful response must mean durable receipt.
 *
 * Trust: same Tailscale-network model as the rest of kbbl. The route does
 * no auth beyond requiring a non-empty kind + projectId on the body.
 * legit-biz-club is expected to be a trusted local caller.
 */
export function mountWorkspaceEventsRoutes(app: Hono): void {
  app.post("/inbox/workspace-events", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    // Reject non-object bodies explicitly. Property access on arrays /
    // strings / numbers silently yields undefined, which would slip a
    // misshapen body through as a no-op accept and mask client bugs.
    if (!isWorkspaceEventRequestBody(raw)) {
      return c.json({ error: "json body must be an object" }, 400);
    }
    const parsed = raw;
    // Trim before the empty check so whitespace-only values are rejected
    // too — matches the artifact_id handling in handlers/sessions.ts.
    const kind =
      typeof parsed.kind === "string" ? parsed.kind.trim() : "";
    if (kind === "") {
      return c.json({ error: "kind must be a non-empty string" }, 400);
    }
    const projectId =
      typeof parsed.projectId === "string" ? parsed.projectId.trim() : "";
    if (projectId === "") {
      return c.json({ error: "projectId must be a non-empty string" }, 400);
    }
    // payload, if present, must be an object when provided — reject 400
    // instead of silently accepting a malformed shape, so a client bug
    // producing a string/number/array payload doesn't look like success.
    if (!isValidPayload(parsed.payload)) {
      return c.json(
        { error: "payload must be an object when provided" },
        400,
      );
    }
    return c.json({ error: "unsupported_workspace_event_ingress", kind, projectId }, 501);
  });
}
