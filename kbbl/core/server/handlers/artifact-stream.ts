import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ArtifactEventBus } from "../../stream/artifact-event-bus";

export interface ArtifactStreamRouteDeps {
  bus: ArtifactEventBus;
}

/**
 * GET /safir-stream?target_type=:t&target_id=:id
 *
 * SSE stream for artifact-scoped events (atom edits, thread updates, status
 * changes). Replays events missed since Last-Event-Id on reconnect.
 * Heartbeat every 15s to keep the connection alive through proxies.
 */
export function mountArtifactStreamRoutes(app: Hono, deps: ArtifactStreamRouteDeps): void {
  const { bus } = deps;

  app.get("/safir-stream", (c) => {
    const targetType = c.req.query("target_type")?.trim();
    const targetId = c.req.query("target_id")?.trim();

    if (!targetType || !targetId) {
      return c.json({ error: "target_type and target_id are required" }, 400);
    }

    const lastEventIdHeader = c.req.header("last-event-id") ?? c.req.query("last_event_id");
    const parsedResumeId = lastEventIdHeader ? Number(lastEventIdHeader) : NaN;
    const resumeAfter = Number.isFinite(parsedResumeId) ? parsedResumeId : -1;

    const clientSignal = c.req.raw.signal;

    const MAX_QUEUE = 500;

    return streamSSE(c, async (stream) => {
      const queue: Array<{ id: number; event: string; data: Record<string, unknown> }> = [];
      let notify: (() => void) | null = null;

      const onAbort = () => {
        if (notify) { const n = notify; notify = null; n(); }
      };
      clientSignal.addEventListener("abort", onAbort, { once: true });

      const unsub = bus.subscribe(targetType, targetId, (evt) => {
        if (queue.length >= MAX_QUEUE) queue.shift();
        queue.push(evt);
        if (notify) { const n = notify; notify = null; n(); }
      });

      const heartbeat = setInterval(() => {
        stream.write(": ping\n\n").catch(() => {});
      }, 15000);

      try {
        // replay missed events
        const replayed = bus.replaySince(targetType, targetId, resumeAfter);
        for (const evt of replayed) {
          await stream.writeSSE({
            event: "message",
            data: JSON.stringify({ event: evt.event, data: evt.data, ts: evt.ts }),
            id: String(evt.id),
          });
        }

        // drain queue entries that arrived during replay to avoid duplicates
        const lastReplayedId = replayed.length > 0 ? replayed[replayed.length - 1].id : resumeAfter;
        while (queue.length > 0 && queue[0].id <= lastReplayedId) queue.shift();

        while (!clientSignal.aborted) {
          if (queue.length === 0) {
            await new Promise<void>((r) => { notify = r; });
            continue;
          }
          const evt = queue.shift()!;
          await stream.writeSSE({
            event: "message",
            data: JSON.stringify({ event: evt.event, data: evt.data }),
            id: String(evt.id),
          });
        }
      } finally {
        clearInterval(heartbeat);
        clientSignal.removeEventListener("abort", onAbort);
        unsub();
      }
    });
  });
}
