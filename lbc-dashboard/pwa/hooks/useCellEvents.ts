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
 *
 * Retry/reconnect: when the EventSource errors before a successful
 * open (the typical launch-time race where the PWA navigates to the
 * cell before the Python child has created its directory), the hook
 * retries with exponential backoff while the matching run is active.
 * The retry window is bounded; once it expires, or the run reaches
 * a terminal state, ``retryError`` is set so the UI can show a
 * diagnosable message instead of silent staleness.
 */
import { useEffect, useRef, useState } from "react";
// useRef is intentionally updated during render (not in an effect) so
// isRunActive() always sees the latest runs value, even mid-render before
// effects have flushed.

import { createCellStreamRetry } from "./cellStreamRetry";
import type { EventSourceLike } from "./cellStreamRetry";
import { useRuns } from "./useRuns";
import type { CellEvent } from "../lib/types";
import type { RunSummary } from "../lib/types";

export function isCellRunActiveForRetry(
  runs: RunSummary[],
  cellId: string,
  hasLoadedRuns: boolean,
): boolean {
  if (!hasLoadedRuns) return true;
  return runs.some((r) => r.cell_id === cellId && r.status === "running");
}

export function useCellEvents(cellId: string | null): {
  events: CellEvent[];
  retryError: string | null;
} {
  const [events, setEvents] = useState<CellEvent[]>([]);
  const [retryError, setRetryError] = useState<string | null>(null);

  const { runs, hasLoaded } = useRuns();
  const runsRef = useRef(runs);
  const hasLoadedRunsRef = useRef(hasLoaded);
  runsRef.current = runs;
  hasLoadedRunsRef.current = hasLoaded;

  useEffect(() => {
    if (cellId === null) {
      setEvents([]);
      setRetryError(null);
      return;
    }

    setEvents([]);
    setRetryError(null);

    let rafCancelled = false;
    let pendingBuffer: CellEvent[] = [];
    let flushScheduled = false;

    const manager = createCellStreamRetry({
      url: `/api/cells/${encodeURIComponent(cellId)}/events`,
      isRunActive: () =>
        isCellRunActiveForRetry(
          runsRef.current,
          cellId,
          hasLoadedRunsRef.current,
        ),
      onEvent: (evt) => {
        pendingBuffer.push(evt);
        if (!flushScheduled) {
          flushScheduled = true;
          requestAnimationFrame(() => {
            if (rafCancelled) return;
            const toFlush = pendingBuffer;
            pendingBuffer = [];
            flushScheduled = false;
            if (toFlush.length > 0) {
              setEvents((prev) => [...prev, ...toFlush]);
            }
          });
        }
      },
      onConnected: () => setRetryError(null),
      onError: setRetryError,
      createEventSource: (url) =>
        new EventSource(url) as unknown as EventSourceLike,
      scheduleRetry: (fn, ms) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      },
      now: () => Date.now(),
    });

    manager.start();

    return () => {
      rafCancelled = true;
      manager.stop();
    };
  }, [cellId]);

  return { events, retryError };
}
