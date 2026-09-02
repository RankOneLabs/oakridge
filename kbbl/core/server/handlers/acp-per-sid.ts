// Browser-facing per-session ACP routes (§14.3–14.8). The PWA consumes
// kbbl UI events only — raw ACP JSON-RPC never crosses this boundary
// (guardrail 4). Mounted under /sessions/:sid/*.

import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import type { AcpSessionService } from "../../acp/session-service";

const HEARTBEAT_MS = 15_000;

// UUID v4 specifically — sids come from crypto.randomUUID(), which always
// produces v4. Accepting other versions would be dead space that never
// matches any real sid the server wrote. Shared by every per-sid route
// (ACP and adjacent: session CRUD, skills, compaction handoff) so a
// URL-encoded path-traversal sid can't slip past any of them.
export const SID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidSid(sid: string): boolean {
  return SID_PATTERN.test(sid);
}

export interface AcpPerSidRouteDeps {
  acp: AcpSessionService;
}

export function mountAcpPerSidRoutes(app: Hono, deps: AcpPerSidRouteDeps): void {
  const { acp } = deps;

  // History (§14.3): live projection buffer when available, otherwise a
  // lazy respawn + session/load replay. Never a transcript file.
  app.get("/sessions/:sid/history", async (c) => {
    const sid = c.req.param("sid");
    if (!isValidSid(sid)) return c.json({ error: "invalid sid" }, 400);
    const acquired = await acp.acquireHistory(sid, c.req.raw.signal);
    if (!acquired.ok) {
      const status = acquired.error.code === "session_not_found" ? 404 : 503;
      return c.json({ error: acquired.error.detail, code: acquired.error.code }, status);
    }
    try {
      return c.json({
        session_id: sid,
        stream_epoch: acp.streamEpoch(sid),
        expired: acquired.value.history.expired,
        events: acquired.value.history.events,
      });
    } finally {
      await acquired.value.release();
    }
  });

  // Live stream (§14.4): SSE of AcpUiEvent. Event ids are offsets within
  // one stream_epoch; a reconnect that sees a new epoch must do a fresh
  // history load rather than pretend its old offset still means anything.
  app.get("/sessions/:sid/stream", async (c) => {
    const sid = c.req.param("sid");
    if (!isValidSid(sid)) return c.json({ error: "invalid sid" }, 400);
    const session = acp.getSession(sid);
    if (!session) return c.json({ error: "unknown session" }, 404);
    return streamSSE(c, async (stream) => {
      // Flush before session/load: a cold replay may be expensive and must
      // not leave EventSource on an empty response body.
      await stream.write(": ready\n\n");
      let closed = false;
      let releaseHistory: (() => Promise<void>) | null = null;
      let unsubscribe: (() => void) | null = null;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let resolveDone: (() => void) | null = null;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      const finish = () => {
        if (closed) return;
        closed = true;
        if (heartbeat !== undefined) clearInterval(heartbeat);
        unsubscribe?.();
        unsubscribe = null;
        const release = releaseHistory;
        releaseHistory = null;
        if (release) {
          void release().catch((error: unknown) => {
            console.error(`acp stream: sid=${sid} history release failed`, error);
          });
        }
        resolveDone?.();
      };
      stream.onAbort(finish);

      const acquired = await acp.acquireHistory(sid, c.req.raw.signal);
      if (!acquired.ok) {
        if (!closed) {
          await stream.writeSSE({
            event: "stream_error",
            data: JSON.stringify({
              error: acquired.error.detail,
              code: acquired.error.code,
            }),
          }).catch(() => {});
        }
        finish();
        return;
      }
      releaseHistory = acquired.value.release;
      if (closed) {
        await acquired.value.release();
        releaseHistory = null;
        return;
      }

      try {
        const epoch = acp.streamEpoch(sid);
        await stream.writeSSE({
          event: "epoch",
          data: JSON.stringify({
            stream_epoch: epoch,
            expired: acquired.value.history.expired,
          }),
        });
        let eventId = 0;
        for (const event of acquired.value.history.events) {
          await stream.writeSSE({
            event: "acp",
            id: String(eventId++),
            data: JSON.stringify(event),
          });
        }

        unsubscribe = acp.subscribe(sid, (event) => {
          void stream
            .writeSSE({
              event: "acp",
              id: String(eventId++),
              data: JSON.stringify(event),
            })
            .catch(finish);
        });
        heartbeat = setInterval(() => {
          void stream.write(": ping\n\n").catch(finish);
        }, HEARTBEAT_MS);

        await done;
      } finally {
        finish();
      }
    });
  });

  // Operator input (§14.5). client_message_id is the idempotency key;
  // accepted input queues durably behind any active turn (§11.3).
  app.post("/sessions/:sid/input", async (c) => {
    const sid = c.req.param("sid");
    if (!isValidSid(sid)) return c.json({ error: "invalid sid" }, 400);
    let body: { text?: unknown; client_message_id?: unknown };
    try {
      body = (await c.req.json()) as { text?: unknown; client_message_id?: unknown };
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    if (typeof body.text !== "string" || body.text.trim().length === 0) {
      return c.json({ error: "text must be a non-empty string" }, 400);
    }
    if (
      body.client_message_id !== undefined &&
      (typeof body.client_message_id !== "string" || body.client_message_id.length === 0)
    ) {
      // An empty key would collapse every such input onto the constant
      // turn key "operator:", conflicting unrelated messages.
      return c.json({ error: "client_message_id must be a non-empty string" }, 400);
    }
    const sent = await acp.sendInput(sid, body.text.trim(), {
      ...(typeof body.client_message_id === "string"
        ? { client_message_id: body.client_message_id }
        : {}),
    });
    if (!sent.ok) {
      const status =
        sent.error.code === "session_not_found"
          ? 404
          : sent.error.code === "session_busy" ||
              sent.error.code === "session_fenced" ||
              sent.error.code === "delivery_key_conflict"
            ? 409
            : 503;
      return c.json({ error: sent.error.detail, code: sent.error.code }, status);
    }
    return c.json({ ok: true, turn_key: sent.value.turn_key, status: sent.value.status });
  });

  // Permission answer (§14.6): exactly the option the agent offered —
  // never reduced to a boolean allow/deny (§15.2).
  app.post("/sessions/:sid/permissions/:requestId", async (c) => {
    const sid = c.req.param("sid");
    if (!isValidSid(sid)) return c.json({ error: "invalid sid" }, 400);
    let body: { option_id?: unknown };
    try {
      body = (await c.req.json()) as { option_id?: unknown };
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    if (typeof body.option_id !== "string" || body.option_id.length === 0) {
      return c.json({ error: "option_id must be a non-empty string" }, 400);
    }
    const resolved = acp.resolvePermission(sid, c.req.param("requestId"), body.option_id);
    if (!resolved.ok) {
      const status = resolved.error.code === "session_not_found" ? 404 : 409;
      return c.json({ error: resolved.error.detail, code: resolved.error.code }, status);
    }
    return c.json({ ok: true });
  });

  // Interrupt (§14.7): session/cancel for the active prompt. Not a fence
  // (guardrail 15) — that is DELETE /sessions/:sid?fenced_by=.
  app.post("/sessions/:sid/cancel", async (c) => {
    const sid = c.req.param("sid");
    if (!isValidSid(sid)) return c.json({ error: "invalid sid" }, 400);
    if (!acp.getSession(sid)) return c.json({ error: "unknown session" }, 404);
    const cancelled = await acp.cancelTurn(sid);
    if (!cancelled.ok) {
      return c.json({ error: cancelled.error.detail, code: cancelled.error.code }, 503);
    }
    return c.json({ ok: true });
  });

  // Session config (§12.3): forward one config-option change to the agent.
  app.post("/sessions/:sid/config", async (c) => {
    const sid = c.req.param("sid");
    if (!isValidSid(sid)) return c.json({ error: "invalid sid" }, 400);
    let body: { config_id?: unknown; value?: unknown };
    try {
      body = (await c.req.json()) as { config_id?: unknown; value?: unknown };
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    if (typeof body.config_id !== "string" || body.config_id.length === 0) {
      return c.json({ error: "config_id must be a non-empty string" }, 400);
    }
    if (typeof body.value !== "string" && typeof body.value !== "boolean") {
      return c.json({ error: "value must be a string or boolean" }, 400);
    }
    const applied = await acp.setConfigOption(sid, body.config_id, body.value);
    if (!applied.ok) {
      const status = applied.error.code === "session_not_found" ? 404 : 409;
      return c.json({ error: applied.error.detail, code: applied.error.code }, status);
    }
    return c.json({ ok: true });
  });
}
