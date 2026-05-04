import type { Context } from "hono";
import { streamSSE } from "hono/streaming";

import type { EnvelopeEvent } from "../session/session";
import type { Session } from "../session/session";

/**
 * SSE stream for a single session. Replays JSONL history then tails new
 * envelope events from the session subscriber. Closes when either the client
 * disconnects or the session ends.
 *
 * Honors `Last-Event-Id` so a reconnecting client only receives events it
 * hasn't seen.
 */
export async function streamForSession(session: Session, c: Context) {
  const clientSignal = c.req.raw.signal;
  const endedSignal = session.endedSignal;
  const lastEventIdHeader = c.req.header("last-event-id");
  const parsedResumeId = lastEventIdHeader ? Number(lastEventIdHeader) : NaN;
  const resumeAfter = Number.isFinite(parsedResumeId) ? parsedResumeId : -1;
  return streamSSE(c, async (stream) => {
    const pending: EnvelopeEvent[] = [];
    let notify: (() => void) | null = null;
    const unsub = session.subscribe((evt) => {
      pending.push(evt);
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
    clientSignal.addEventListener("abort", onAbort, { once: true });
    // Close the stream when the session ends — otherwise a client that
    // stays connected to an ended session sits in the empty-pending loop
    // forever, leaking the SSE connection and (after many such ends) the
    // subscribe slot. Either signal aborting is enough to exit the loop.
    endedSignal.addEventListener("abort", onAbort, { once: true });
    const heartbeat = setInterval(() => {
      stream.write(": ping\n\n").catch(() => {});
    }, 15000);
    let sentUpTo = resumeAfter;
    try {
      const contents = await session.readJsonl();
      for (const line of contents.split("\n")) {
        if (!line.trim()) continue;
        let evt: EnvelopeEvent;
        try {
          evt = JSON.parse(line) as EnvelopeEvent;
        } catch {
          console.error(
            `cc-deck: skipping malformed JSONL line: ${line.slice(0, 120)}`,
          );
          continue;
        }
        if (evt.id <= sentUpTo) continue;
        sentUpTo = evt.id;
        await stream.writeSSE({
          event: "message",
          data: JSON.stringify(evt),
          id: String(evt.id),
        });
      }
      while (!clientSignal.aborted && !endedSignal.aborted) {
        if (pending.length === 0) {
          await new Promise<void>((r) => {
            notify = r;
          });
          continue;
        }
        const evt = pending.shift()!;
        if (evt.id <= sentUpTo) continue;
        sentUpTo = evt.id;
        await stream.writeSSE({
          event: "message",
          data: JSON.stringify(evt),
          id: String(evt.id),
        });
      }
      // Drain any events that arrived between the last pending.shift() and
      // the abort so clients don't miss the final subprocess_exited frame.
      // Only drain when the session ended but the client is still connected —
      // if the client aborted, writing to the dead socket would just throw,
      // and there's no one to miss the frame anyway.
      if (endedSignal.aborted && !clientSignal.aborted) {
        while (pending.length > 0) {
          const evt = pending.shift()!;
          if (evt.id <= sentUpTo) continue;
          sentUpTo = evt.id;
          await stream.writeSSE({
            event: "message",
            data: JSON.stringify(evt),
            id: String(evt.id),
          });
        }
      }
    } finally {
      clearInterval(heartbeat);
      clientSignal.removeEventListener("abort", onAbort);
      endedSignal.removeEventListener("abort", onAbort);
      unsub();
    }
  });
}

/**
 * GET /:sid/events handler — JSON snapshot of all envelope events with
 * `id > since`. Used by the PWA on initial load to populate event history
 * before connecting the SSE stream.
 */
export async function eventsForSession(session: Session, c: Context) {
  const sinceRaw = c.req.query("since");
  const since = sinceRaw !== undefined ? Number(sinceRaw) : -1;
  if (!Number.isFinite(since)) {
    return c.json({ error: "invalid since" }, 400);
  }
  const contents = await session.readJsonl();
  return c.json({
    session_id: session.oakridgeSid,
    events: parseEventsSince(contents, since),
  });
}

/**
 * Parse a JSONL transcript and return all events with `id > since`.
 * Malformed lines are logged and skipped rather than raised.
 */
export function parseEventsSince(contents: string, since: number): EnvelopeEvent[] {
  const events: EnvelopeEvent[] = [];
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    let evt: EnvelopeEvent;
    try {
      evt = JSON.parse(line) as EnvelopeEvent;
    } catch {
      console.error(
        `cc-deck: skipping malformed JSONL line: ${line.slice(0, 120)}`,
      );
      continue;
    }
    if (evt.id > since) events.push(evt);
  }
  return events;
}
