import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { selectRunEvent, type RunEventCursor } from "../projections/run-event";
import { readLatestEventCursor, readTransitionsAfter } from "../storage/projection-reader";
import type { TransactionalSqlExecutor } from "../storage/sql-executor";

/** The SSE id is the base64url JSON cursor; Last-Event-ID hands it back on reconnect. */
const encodeEventCursor = (cursor: RunEventCursor): string => Buffer.from(JSON.stringify(cursor)).toString("base64url");
function decodeEventCursor(raw: string): RunEventCursor | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || !("commit_txid" in value) || typeof value.commit_txid !== "string"
      || !/^\d{1,20}$/.test(value.commit_txid) || !("id" in value) || typeof value.id !== "string" || !value.id) return null;
    return { commit_txid: value.commit_txid, id: value.id };
  } catch { return null; }
}

export interface EventStreamTiming { readonly poll_ms: number; readonly heartbeat_ms: number }
const DEFAULT_EVENT_TIMING: EventStreamTiming = { poll_ms: 1_000, heartbeat_ms: 15_000 };
const PAGE = 100;

/**
 * GET /events streams committed transitions as `run_event` frames. Each frame's
 * id is its resume cursor, so a reconnect with Last-Event-ID continues where it
 * stopped; a new subscriber starts from now. It reads the transition log, so it
 * adds no write path and no coordination with the run workflows.
 */
export function installEventStream(app: Hono, deps: { readonly db: TransactionalSqlExecutor; readonly timing?: EventStreamTiming }): void {
  const timing = deps.timing ?? DEFAULT_EVENT_TIMING;
  app.get("/events", async (c) => {
    const resume = c.req.header("last-event-id");
    let cursor: RunEventCursor | null = resume ? decodeEventCursor(resume) : null;
    if (resume && cursor === null) return c.json({ error: "malformed_request", detail: "invalid event cursor" }, 400);
    return streamSSE(c, async (stream) => {
      // Fix the starting point before signalling ready, so every commit after ready is delivered.
      cursor ??= await readLatestEventCursor(deps.db);
      await stream.write(": ready\n\n");
      let last_write = Date.now();
      while (!stream.aborted && !stream.closed) {
        const rows = await readTransitionsAfter(deps.db, cursor, PAGE);
        for (const row of rows) {
          cursor = { commit_txid: row.commit_txid, id: row.id };
          await stream.writeSSE({ event: "run_event", id: encodeEventCursor(cursor), data: JSON.stringify(selectRunEvent(row)) });
          last_write = Date.now();
        }
        if (rows.length === PAGE) continue;
        if (Date.now() - last_write >= timing.heartbeat_ms) { await stream.write(": ping\n\n"); last_write = Date.now(); }
        await stream.sleep(timing.poll_ms);
      }
    });
  });
}
