import type { Context } from "hono";
import { streamSSE } from "hono/streaming";

import type {
  InboxDelta,
  SessionManager,
} from "../session/session-manager";

/**
 * GET /inbox handler — SSE delta stream over the session list.
 *
 * Emits one snapshot frame on connect (the full session list at the moment
 * the connection opens), then deltas as sessions get created/ended/etc. On
 * any reconnect, the fresh snapshot is authoritative — deltas missed in
 * between the disconnect and reconnect are not replayed, which is fine
 * because the snapshot carries every field the deltas mutate.
 */
export function inboxHandler(manager: SessionManager) {
  return (c: Context) => {
    return streamSSE(c, async (stream) => {
      const signal = c.req.raw.signal;
      // Per-connection buffer of deltas pending writeSSE. Unbounded by
      // design for v0: each delta is ~100 bytes, sessions move slowly, and
      // snapshot-on-reconnect makes drop-on-overflow safe if we ever need
      // to cap it. If a backgrounded client on a busy server ever shows up
      // as a memory regression, swap this for a ring buffer + forced close
      // on overflow — the reconnect will pull a fresh snapshot.
      const queue: InboxDelta[] = [];
      let notify: (() => void) | null = null;
      const unsub = manager.subscribeInbox((delta) => {
        queue.push(delta);
        if (notify) {
          const n = notify;
          notify = null;
          n();
        }
      });
      const onAbort = () => {
        if (notify) {
          const n = notify;
          notify = null;
          n();
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const heartbeat = setInterval(() => {
        stream.write(": ping\n\n").catch(() => {});
      }, 15000);
      try {
        await stream.writeSSE({
          event: "snapshot",
          data: JSON.stringify({ sessions: manager.listSnapshots() }),
        });
        while (!signal.aborted) {
          if (queue.length === 0) {
            await new Promise<void>((r) => {
              notify = r;
            });
            continue;
          }
          const delta = queue.shift()!;
          await stream.writeSSE({
            event: "delta",
            data: JSON.stringify(delta),
          });
        }
      } finally {
        clearInterval(heartbeat);
        signal.removeEventListener("abort", onAbort);
        unsub();
      }
    });
  };
}
