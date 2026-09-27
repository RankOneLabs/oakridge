import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { RunEvent } from "../domain/run-event";

/**
 * Comment frames on an otherwise silent stream keep intermediaries — and Bun's
 * own idle timer — seeing traffic. Fifteen seconds matches the kbbl SSE
 * convention so both hops behave the same way.
 */
const HEARTBEAT_INTERVAL_MS = 15_000;

export interface InvalidationEventDependencies {
  readonly current_cursor: () => Promise<string>;
  readonly list_run_events?: (after_sequence: string | null, limit: number) => Promise<readonly RunEvent[]>;
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

const sequenceFromCursor = (cursor: string): string | null => {
  const candidate = cursor.split(":").at(-1);
  return candidate !== undefined && /^\d+$/.test(candidate) ? candidate : null;
};

const writeRunEvents = async (
  stream: Parameters<Parameters<typeof streamSSE>[1]>[0],
  events: readonly RunEvent[],
  replayed: boolean,
): Promise<string | null> => {
  let last: string | null = null;
  for (const event of events) {
    last = event.sequence;
    await stream.writeSSE({ event: "run_event", id: event.sequence, data: JSON.stringify({ ...event, replayed }) });
  }
  return last;
};

const writeAvailableRunEvents = async (
  stream: Parameters<Parameters<typeof streamSSE>[1]>[0],
  list: NonNullable<InvalidationEventDependencies["list_run_events"]>,
  afterSequence: string,
  replayed: boolean,
): Promise<string> => {
  let cursor = afterSequence;
  while (true) {
    const events = await list(cursor, 500);
    cursor = await writeRunEvents(stream, events, replayed) ?? cursor;
    if (events.length < 500) return cursor;
  }
};

export const createInvalidationEventApp = (dependencies: InvalidationEventDependencies): Hono => {
  const app = new Hono();
  app.get("/events", (http) => streamSSE(http, async (stream) => {
    const pollIntervalMs = dependencies.poll_interval_ms ?? 1_000;
    const heartbeatIntervalMs = dependencies.heartbeat_interval_ms ?? HEARTBEAT_INTERVAL_MS;
    const liveCursorPromise = dependencies.current_cursor();
    await stream.write(": ready\n\n");
    const lastEventId = http.req.header("last-event-id");
    const liveCursor = await liveCursorPromise;
    let cursor = selectBaselineCursor(lastEventId, liveCursor);
    let eventSequence = lastEventId && /^\d+$/.test(lastEventId) ? lastEventId : sequenceFromCursor(liveCursor);
    if (lastEventId && eventSequence && dependencies.list_run_events) {
      eventSequence = await writeAvailableRunEvents(stream, dependencies.list_run_events, eventSequence, true);
    }
    let msSinceLastWrite = 0;
    while (!stream.aborted) {
      await stream.sleep(pollIntervalMs);
      const next = await dependencies.current_cursor();
      if (next !== cursor) {
        cursor = next;
        msSinceLastWrite = 0;
        await stream.writeSSE({ event: "invalidate", data: JSON.stringify({ kind: "invalidate" }), id: cursor });
        if (dependencies.list_run_events && eventSequence) {
          eventSequence = await writeAvailableRunEvents(stream, dependencies.list_run_events, eventSequence, false);
        }
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
