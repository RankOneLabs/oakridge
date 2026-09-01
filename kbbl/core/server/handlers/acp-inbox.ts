// GET /inbox — snapshot-push SSE over the ACP session list (§14.1).
//
// The legacy inbox streamed a taxonomy of per-field deltas because the old
// SessionManager already had an event per mutation. The ACP substrate has a
// coarse change feed instead, and the session list is small, so this stream
// sends the full snapshot on every change: one wire shape, no client-side
// folding, and a reconnect needs no replay reasoning — the next frame is
// always authoritative.

import type { Context } from "hono";
import { streamSSE } from "hono/streaming";

import type { AcpSessionService } from "../../acp/session-service";
import { toPwaSessionSnapshot, type PwaSessionSnapshot } from "../../acp/pwa-wire";

const HEARTBEAT_MS = 15_000;
/** Trailing coalesce window: a burst of store writes (provision, turn
 * start, activity touches) becomes one snapshot frame. */
const COALESCE_MS = 25;

export function listPwaSessions(acp: AcpSessionService): PwaSessionSnapshot[] {
  return acp
    .listSessions()
    .map((session) =>
      toPwaSessionSnapshot(session, acp.pendingPermissionCount(session.sid)),
    )
    .sort((left, right) => {
      if (left.lastActivityTs === right.lastActivityTs) return 0;
      return left.lastActivityTs < right.lastActivityTs ? 1 : -1;
    });
}

export function acpInboxHandler(acp: AcpSessionService) {
  return (c: Context) => {
    return streamSSE(c, async (stream) => {
      const signal = c.req.raw.signal;
      let dirty = false;
      let notify: (() => void) | null = null;
      let coalesceTimer: ReturnType<typeof setTimeout> | null = null;

      const wake = () => {
        if (notify) {
          const n = notify;
          notify = null;
          n();
        }
      };
      const markDirty = () => {
        // The store fires listeners synchronously inside its own writes
        // (sometimes mid-transaction); only schedule here, never read.
        if (coalesceTimer !== null) return;
        coalesceTimer = setTimeout(() => {
          coalesceTimer = null;
          dirty = true;
          wake();
        }, COALESCE_MS);
      };
      const unsubscribe = acp.subscribeSessionsChanged(markDirty);
      signal.addEventListener("abort", wake, { once: true });
      const heartbeat = setInterval(() => {
        stream.write(": ping\n\n").catch(() => {});
      }, HEARTBEAT_MS);

      try {
        // SSE readiness: flush before anything that can block so the
        // EventSource leaves "connecting" immediately.
        await stream.write(": ready\n\n");
        await stream.writeSSE({
          event: "snapshot",
          data: JSON.stringify({ sessions: listPwaSessions(acp) }),
        });
        while (!signal.aborted) {
          if (!dirty) {
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
            continue;
          }
          dirty = false;
          await stream.writeSSE({
            event: "snapshot",
            data: JSON.stringify({ sessions: listPwaSessions(acp) }),
          });
        }
      } finally {
        clearInterval(heartbeat);
        if (coalesceTimer !== null) clearTimeout(coalesceTimer);
        signal.removeEventListener("abort", wake);
        unsubscribe();
      }
    });
  };
}
