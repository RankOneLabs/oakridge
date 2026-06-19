import type { Context, Hono } from "hono";
import { join } from "node:path";

import {
  Session,
  SessionNotReadyError,
  readJsonlOrEmpty,
} from "../../session/session";
import type { SessionManager } from "../../session/session-manager";
import {
  eventsForSession,
  parseEventsSince,
  streamForSession,
} from "../../stream/sse";

// UUID v4 specifically — sids come from crypto.randomUUID(), which always
// produces v4. Accepting other versions would be dead space that never
// matches any real sid the server wrote.
export const SID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidSid(sid: string): boolean {
  return SID_PATTERN.test(sid);
}

async function inputForSession(session: Session, c: Context) {
  let body: { text?: unknown };
  try {
    body = (await c.req.json()) as { text?: unknown };
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  if (typeof body.text !== "string") {
    return c.json({ error: "text must be a string" }, 400);
  }
  const text = body.text.trim();
  if (text.length === 0) {
    return c.json({ error: "text must be non-empty" }, 400);
  }
  // [hang-debug] Trace POST /:sid/input end-to-end so the "input submit
  // does nothing / UI stuck on thinking" failure can be diagnosed from
  // server stderr without reproducing in the act.
  const debugStart = Date.now();
  const debugHead = text.slice(0, 60).replace(/\s+/g, " ");
  console.debug(
    `[hang-debug] input.recv sid=${session.oakridgeSid} status=${session.status} bytes=${text.length} head=${JSON.stringify(debugHead)}`,
  );
  try {
    await session.writeInput(text);
  } catch (err) {
    if (err instanceof SessionNotReadyError) {
      console.debug(
        `[hang-debug] input.reject sid=${session.oakridgeSid} reason=not_ready elapsed_ms=${Date.now() - debugStart}`,
      );
      return c.json({ error: "subprocess not ready" }, 503);
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.debug(
      `[hang-debug] input.error sid=${session.oakridgeSid} elapsed_ms=${Date.now() - debugStart} err=${JSON.stringify(msg)}`,
    );
    return c.json({ error: `subprocess write failed: ${msg}` }, 503);
  }
  console.debug(
    `[hang-debug] input.ok sid=${session.oakridgeSid} elapsed_ms=${Date.now() - debugStart}`,
  );
  return c.json({ ok: true });
}

async function yoloForSession(session: Session, c: Context) {
  if (session.status !== "live") {
    return c.json({ error: "session not live" }, 409);
  }
  let body: { enabled?: unknown };
  try {
    body = (await c.req.json()) as { enabled?: unknown };
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  if (typeof body.enabled !== "boolean") {
    return c.json({ error: "enabled must be a boolean" }, 400);
  }
  const enabled = await session.setYolo(body.enabled);
  return c.json({ ok: true, enabled });
}

interface ApprovalBody {
  request_id: string;
  decision: "approve" | "deny";
  scope: "once" | "always";
}

function parseApprovalBody(raw: unknown): ApprovalBody | string {
  if (typeof raw !== "object" || raw === null) return "invalid json";
  const body = raw as {
    request_id?: unknown;
    decision?: unknown;
    scope?: unknown;
  };
  if (typeof body.request_id !== "string") return "request_id must be a string";
  if (body.decision !== "approve" && body.decision !== "deny") {
    return "decision must be 'approve' or 'deny'";
  }
  if (
    body.scope !== undefined &&
    body.scope !== "once" &&
    body.scope !== "always"
  ) {
    return "scope must be 'once' or 'always'";
  }
  return {
    request_id: body.request_id,
    decision: body.decision,
    scope: (body.scope ?? "once") as "once" | "always",
  };
}

async function applyApproval(
  session: Session,
  body: ApprovalBody,
  c: Context,
) {
  if (session.status !== "live") {
    return c.json({ error: "session not live" }, 409);
  }
  const pending = session.deleteApproval(body.request_id);
  if (!pending) {
    return c.json({ error: "unknown or already-resolved request_id" }, 404);
  }
  pending.resolve(body.decision === "approve" ? "allow" : "deny");
  if (body.scope === "always" && body.decision === "approve") {
    try {
      await session.allowlistTool(pending.toolName);
    } catch (err) {
      console.error(
        `kbbl: allowlist side-effect for ${pending.toolName} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return c.json({ ok: true });
}

async function approvalForSession(session: Session, c: Context) {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  const parsed = parseApprovalBody(raw);
  if (typeof parsed === "string") return c.json({ error: parsed }, 400);
  return applyApproval(session, parsed, c);
}

async function interruptForSession(session: Session, c: Context) {
  const outcome = await session.interrupt();
  if (outcome.ok) return c.json({ ok: true });
  // "nothing to interrupt" is a 409 (session isn't running a turn this transport
  // can cancel); an IO failure in the runtime's interrupt call is a 503, mirroring
  // /input. The session never lets the runtime throw escape as an unclassified 500.
  if (outcome.reason === "io_failed") {
    return c.json({ error: `interrupt failed: ${outcome.detail ?? "unknown"}` }, 503);
  }
  return c.json({ error: "session not live or interrupt unsupported" }, 409);
}

export interface PerSidRouteDeps {
  manager: SessionManager;
  sessionsDir: string;
}

/**
 * Registers `/:sid/stream`, `/:sid/events`, `/:sid/input`, `/:sid/yolo`,
 * `/:sid/approval`, `/:sid/interrupt`, and `/:sid/compact` on the given Hono app.
 */
export function mountPerSidRoutes(app: Hono, deps: PerSidRouteDeps): void {
  const { manager, sessionsDir } = deps;

  app.get("/:sid/stream", (c) => {
    const session = manager.get(c.req.param("sid"));
    if (!session) return c.json({ error: "unknown session" }, 404);
    return streamForSession(session, c);
  });

  app.get("/:sid/events", async (c) => {
    const sid = c.req.param("sid");
    // Validate sid before falling through to the filesystem — the archived
    // path joins sid into sessionsDir, and a URL-encoded traversal like
    // `..%2F..%2Fetc%2Fpasswd` would otherwise let a tailnet peer read
    // arbitrary *.jsonl files the server has access to. sids are generated
    // by randomUUID() so a strict UUID-v4 regex is tight enough without
    // needing a path-prefix check.
    if (!isValidSid(sid)) return c.json({ error: "invalid sid" }, 400);
    const session = manager.get(sid);
    if (session) return eventsForSession(session, c);
    // Fall through to on-disk JSONL for sessions that aren't loaded in
    // memory (e.g. after a server restart). Matches the snapshot view an
    // archived session gets from /sessions?include=archived: fully-formed
    // transcript, no live updates.
    const sinceRaw = c.req.query("since");
    const since = sinceRaw !== undefined ? Number(sinceRaw) : -1;
    if (!Number.isFinite(since)) {
      return c.json({ error: "invalid since" }, 400);
    }
    const jsonlPath = join(sessionsDir, `${sid}.jsonl`);
    const contents = await readJsonlOrEmpty(jsonlPath);
    if (!contents) return c.json({ error: "unknown session" }, 404);
    return c.json({
      session_id: sid,
      events: parseEventsSince(contents, since),
    });
  });

  app.post("/:sid/input", async (c) => {
    const session = manager.get(c.req.param("sid"));
    if (!session) return c.json({ error: "unknown session" }, 404);
    return inputForSession(session, c);
  });

  app.post("/:sid/yolo", async (c) => {
    const session = manager.get(c.req.param("sid"));
    if (!session) return c.json({ error: "unknown session" }, 404);
    return yoloForSession(session, c);
  });

  app.post("/:sid/approval", async (c) => {
    const session = manager.get(c.req.param("sid"));
    if (!session) return c.json({ error: "unknown session" }, 404);
    return approvalForSession(session, c);
  });

  app.post("/:sid/interrupt", async (c) => {
    const session = manager.get(c.req.param("sid"));
    if (!session) return c.json({ error: "unknown session" }, 404);
    return interruptForSession(session, c);
  });

  app.post("/:sid/compact", (c) => {
    const sid = c.req.param("sid");
    if (!isValidSid(sid)) return c.json({ error: "invalid sid" }, 400);
    const result = manager.requestManualCompact(sid);
    if (result === "not_found") return c.json({ error: "session not found" }, 404);
    if (result === "not_live") return c.json({ error: "session not live" }, 409);
    return c.json({ ok: true }, 202);
  });
}
