/**
 * Live SSE event stream for one cell. Replays existing events on
 * connect, then appends as new events arrive. Resets when cellId
 * changes; guards against late deliveries from a previously-
 * selected cell.
 *
 * Incoming events are buffered in a closure-local array and flushed
 * on the next animation frame in one setState call. Without
 * batching, replay of a cell with N backlog events would call
 * ``setEvents((prev) => [...prev, evt])`` N times — O(N²) array
 * copies. With it, a backlog burst becomes one append per frame.
 */
import { useEffect, useState } from "react";

import type { CellEvent } from "../lib/types";

export function useCellEvents(cellId: string | null): CellEvent[] {
  const [events, setEvents] = useState<CellEvent[]>([]);
  useEffect(() => {
    if (cellId === null) {
      setEvents([]);
      return;
    }
    setEvents([]);
    // Per-effect buffer + flush flag, reset cleanly on cellId change.
    let pendingBuffer: CellEvent[] = [];
    let flushScheduled = false;
    let cancelled = false;
    const es = new EventSource(
      `/api/cells/${encodeURIComponent(cellId)}/events`,
    );
    es.addEventListener("message", (ev) => {
      if (cancelled) return;
      let evt: CellEvent;
      try {
        evt = JSON.parse(ev.data) as CellEvent;
      } catch {
        return;
      }
      pendingBuffer.push(evt);
      if (!flushScheduled) {
        flushScheduled = true;
        requestAnimationFrame(() => {
          if (cancelled) return;
          const toFlush = pendingBuffer;
          pendingBuffer = [];
          flushScheduled = false;
          if (toFlush.length > 0) {
            setEvents((prev) => [...prev, ...toFlush]);
          }
        });
      }
    });
    return () => {
      cancelled = true;
      es.close();
    };
  }, [cellId]);
  return events;
}
