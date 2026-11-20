// Browser-facing per-session ACP routes (§14.3–14.8). The PWA consumes
// kbbl transcript frames only — raw ACP JSON-RPC never crosses this boundary
// (guardrail 4). Mounted under /sessions/:sid/*.

import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import { buildEpochFrame, streamErrorFrame, type SessionWireFrame } from "#kbbl/core/acp/session-wire";

import { DEFAULT_SSE_LIMITS, guardSseStream } from "./sse-backpressure";

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

  app.get("/sessions/:sid/usage", (c) => {
    const sid = c.req.param("sid");
    if (!isValidSid(sid)) return c.json({ error: "invalid sid" }, 400);
    if (!acp.getSession(sid)) return c.json({ error: `no session ${sid}`, code: "session_not_found" }, 404);
    return c.json(acp.readUsage(sid));
  });

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
      return c.json(buildEpochFrame({
        history: acquired.value.history,
        stream_epoch: acp.streamEpoch(sid),
        initial_item_window: acp.transcriptLimits.initial_item_window,
      }));
    } finally {
      await acquired.value.release();
    }
  });

  app.get("/sessions/:sid/items", (c) => {
    const sid = c.req.param("sid");
    if (!isValidSid(sid)) return c.json({ error: "invalid sid" }, 400);
    const epoch = c.req.query("epoch");
    if (!epoch?.trim()) return c.json({ error: "epoch is required", code: "invalid_epoch" }, 400);
    const cursor = c.req.query("before_seq");
    const before_seq = Number(cursor);
    if (!cursor?.trim() || !Number.isSafeInteger(before_seq) || before_seq < 0) {
      return c.json({ error: "before_seq must be a non-negative integer", code: "invalid_before_seq" }, 400);
    }
    const rawLimit = c.req.query("limit");
    const { item_page_limit, item_page_limit_max } = acp.transcriptLimits;
    const limit = rawLimit === undefined ? item_page_limit : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > item_page_limit_max) {
      return c.json({ error: `limit must be an integer between 1 and ${item_page_limit_max}`, code: "invalid_limit" }, 400);
    }
    const page = acp.readItemPage(sid, { epoch, before_seq, limit });
    if (!page.ok) return c.json({ error: page.error.detail, code: page.error.code }, 404);
    return c.json(page.value, page.value.kind === "epoch_changed" ? 409 : 200);
  });

  app.get("/sessions/:sid/stream", (c) => {
    const sid = c.req.param("sid");
    if (!isValidSid(sid)) return c.json({ error: "invalid sid" }, 400);
    if (!acp.getSession(sid)) return c.json({ error: "unknown session" }, 404);
    return streamSSE(c, async (stream) => {
      const guard = guardSseStream(stream);
      let closed = false;
      let releaseHistory: (() => Promise<void>) | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const { promise: done, resolve: resolveDone } = Promise.withResolvers<void>();
      const loading = new AbortController();
      const abort = () => stream.abort();
      const finish = () => {
        if (closed) return;
        closed = true;
        if (heartbeat !== undefined) clearInterval(heartbeat);
        c.req.raw.signal.removeEventListener("abort", abort);
        if (releaseHistory) {
          void releaseHistory().catch((error: unknown) => {
            console.error(`acp stream: sid=${sid} history release failed`, error);
          });
        } else {
          loading.abort();
        }
        resolveDone();
      };
      stream.onAbort(finish);
      c.req.raw.signal.addEventListener("abort", abort, { once: true });

      const send = (frame: SessionWireFrame) => guard.send({ event: frame.kind, data: JSON.stringify(frame) });
      const queued: SessionWireFrame[] = [];
      let is_initial_written = false;
      try {
        // Flush before session/load, which may need to spawn a replay child.
        await stream.write(": ready\n\n");
        if (closed || c.req.raw.signal.aborted) return;
        const acquired = await acp.openSessionStream(sid, (frames) => {
          if (closed) return;
          if (is_initial_written) {
            for (const frame of frames) void send(frame);
          } else if (queued.length + frames.length > DEFAULT_SSE_LIMITS.max_pending_writes) {
            stream.abort();
          } else {
            queued.push(...frames);
          }
        }, loading.signal);
        if (!acquired.ok) {
          if (!closed) await send(streamErrorFrame(acquired.error));
          return;
        }
        if (closed) {
          await acquired.value.release();
          return;
        }
        releaseHistory = acquired.value.release;
        heartbeat = setInterval(() => {
          guard.checkStall();
          if (is_initial_written) void guard.sendRaw(": ping\n\n");
        }, HEARTBEAT_MS);

        await send(acquired.value.epoch_frame);
        if (closed) return;
        for (const frame of queued) void send(frame);
        queued.length = 0;
        is_initial_written = true;
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
