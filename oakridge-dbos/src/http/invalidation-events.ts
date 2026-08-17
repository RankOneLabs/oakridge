import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

/**
 * Comment frames on an otherwise silent stream keep intermediaries — and Bun's
 * own idle timer — seeing traffic. Fifteen seconds matches the kbbl SSE
 * convention so both hops behave the same way.
 */
const HEARTBEAT_INTERVAL_MS = 15_000;

export interface InvalidationEventDependencies {
  readonly current_cursor: () => Promise<string>;
  readonly poll_interval_ms?: number;
  readonly heartbeat_interval_ms?: number;
}

/**
 * The cursor a stream resumes from. `Last-Event-ID` carries the last cursor the
 * client actually received, so anything that changed while it was disconnected
 * still differs from that baseline and produces one catch-up invalidate.
 * Re-baselining on the live cursor instead — the only behaviour available
 * before this — silently swallowed every change that happened during the gap.
 */
export const selectBaselineCursor = (last_event_id: string | undefined, current_cursor: string): string =>
  last_event_id !== undefined && last_event_id.length > 0 ? last_event_id : current_cursor;

export const createInvalidationEventApp = (dependencies: InvalidationEventDependencies): Hono => {
  const app = new Hono();
  app.get("/events", (http) => streamSSE(http, async (stream) => {
    const pollIntervalMs = dependencies.poll_interval_ms ?? 1_000;
    const heartbeatIntervalMs = dependencies.heartbeat_interval_ms ?? HEARTBEAT_INTERVAL_MS;
    let cursor = selectBaselineCursor(http.req.header("last-event-id"), await dependencies.current_cursor());
    await stream.write(": ready\n\n");
    let msSinceLastWrite = 0;
    while (!stream.aborted) {
      await stream.sleep(pollIntervalMs);
      const next = await dependencies.current_cursor();
      if (next !== cursor) {
        cursor = next;
        msSinceLastWrite = 0;
        await stream.writeSSE({ event: "invalidate", data: JSON.stringify({ kind: "invalidate" }), id: cursor });
        continue;
      }
      msSinceLastWrite += pollIntervalMs;
      if (msSinceLastWrite < heartbeatIntervalMs) continue;
      msSinceLastWrite = 0;
      await stream.write(": ping\n\n");
    }
  }));
  return app;
};
