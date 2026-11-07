// GET /inbox — snapshot-push SSE over the ACP session list (§14.1).
//
// Each connection opens with the full snapshot, so a reconnect needs no replay
// reasoning. The inventory keeps every ended session, so after that the ACP
// substrate's coarse change feed becomes `changes` frames holding only the
// sessions that differ from what this connection last sent.

import type { Context } from "hono";
import { streamSSE } from "hono/streaming";

import type { AcpSessionService } from "../../acp/session-service";
import { selectPwaSessionChanges, toPwaSessionSnapshot, type PwaSessionSnapshot } from "../../acp/pwa-wire";
import { compareSessionsByActivity } from "../../acp/pwa-session-order";
import { guardSseStream } from "./sse-backpressure";

const HEARTBEAT_MS = 15_000;
/** Trailing coalesce window: a burst of store writes (provision, turn
 * start, activity touches) becomes one frame. */
const COALESCE_MS = 25;

export function listPwaSessions(acp: AcpSessionService): PwaSessionSnapshot[] {
  const archives = acp.listSessionArchives();
  return acp
    .listSessions()
    .map((session) =>
      toPwaSessionSnapshot(session, acp.pendingPermissionCount(session.sid), archives.get(session.sid) ?? null),
    )
    .sort(compareSessionsByActivity);
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
      const guard = guardSseStream(stream);
      const unsubscribe = acp.subscribeSessionsChanged(markDirty);
      signal.addEventListener("abort", wake, { once: true });
      stream.onAbort(wake);
      const heartbeat = setInterval(() => {
        guard.checkStall();
        void guard.sendRaw(": ping\n\n");
      }, HEARTBEAT_MS);

      try {
        // SSE readiness: flush before anything that can block so the
        // EventSource leaves "connecting" immediately.
        await stream.write(": ready\n\n");
        let sent = listPwaSessions(acp);
        await guard.send({ event: "snapshot", data: JSON.stringify({ sessions: sent }) });
        while (!signal.aborted && !stream.aborted) {
          if (!dirty) {
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
            continue;
          }
          dirty = false;
          const current = listPwaSessions(acp);
          const changes = selectPwaSessionChanges(sent, current);
          sent = current;
          if (changes.sessions.length === 0 && changes.removedSids.length === 0) continue;
          await guard.send({ event: "changes", data: JSON.stringify(changes) });
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
