// Browser-facing per-session ACP routes (§14.3–14.8). The PWA consumes
// kbbl UI events only — raw ACP JSON-RPC never crosses this boundary
// (guardrail 4). Mounted under /sessions/:sid/* so the legacy /:sid/*
// routes keep serving pre-cutover JSONL sessions untouched.

import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import type { AcpSessionService } from "../../acp/session-service";
import { isValidSid } from "./per-sid";

const HEARTBEAT_MS = 15_000;

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
    const history = await acp.loadHistory(sid);
    if (!history.ok) {
      const status = history.error.code === "session_not_found" ? 404 : 503;
      return c.json({ error: history.error.detail, code: history.error.code }, status);
    }
    return c.json({
      session_id: sid,
      stream_epoch: acp.streamEpoch(sid),
      expired: history.value.expired,
      events: history.value.events,
    });
  });

  // Live stream (§14.4): SSE of AcpUiEvent. Event ids are offsets within
  // one stream_epoch; a reconnect that sees a new epoch must do a fresh
  // history load rather than pretend its old offset still means anything.
  app.get("/sessions/:sid/stream", async (c) => {
    const sid = c.req.param("sid");
    if (!isValidSid(sid)) return c.json({ error: "invalid sid" }, 400);
    const session = acp.getSession(sid);
    if (!session) return c.json({ error: "unknown session" }, 404);
    // Touch so an idle session without a live child respawns via load and
    // the stream has a projection to attach to.
    const history = await acp.loadHistory(sid);
    if (!history.ok) {
      return c.json({ error: history.error.detail, code: history.error.code }, 503);
    }
    const epoch = acp.streamEpoch(sid);

    return streamSSE(c, async (stream) => {
      // SSE readiness: write before any path that can block, so the
      // EventSource never sits on an empty body until the heartbeat.
      await stream.write(": ready\n\n");
      await stream.writeSSE({
        event: "epoch",
        data: JSON.stringify({ stream_epoch: epoch }),
      });
      let eventId = 0;
      for (const event of history.value.events) {
        await stream.writeSSE({
          event: "acp",
          id: String(eventId++),
          data: JSON.stringify(event),
        });
      }

      let closed = false;
      const done = new Promise<void>((resolveDone) => {
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        let unsubscribe: (() => void) | null = null;
        // All teardown lives in finish: a rejected write resolves the
        // stream WITHOUT firing onAbort (Hono closes on normal callback
        // return), so cleanup hung off onAbort alone would leak the
        // interval and the ACP subscription per disconnected client.
        const finish = () => {
          if (closed) return;
          closed = true;
          if (heartbeat !== undefined) clearInterval(heartbeat);
          unsubscribe?.();
          resolveDone();
        };
        stream.onAbort(finish);

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
        // No live controller (ended/failed session): nothing further will
        // arrive; leave the stream open on heartbeats so the client owns
        // the close, exactly like an ended legacy session's stream.
      });
      await done;
    });
  });

  // Operator input (§14.5). client_message_id is the idempotency key; a
  // busy session answers 409 — operator input never queues (§11.3).
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
