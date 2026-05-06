/**
 * Live SSE event stream for one cell. Replays existing events on
 * connect, then appends as new events arrive. Resets when cellId
 * changes; guards against late deliveries from a previously-
 * selected cell.
 */
import { useEffect, useRef, useState } from "react";

import type { CellEvent } from "../lib/types";

export function useCellEvents(cellId: string | null): CellEvent[] {
  const [events, setEvents] = useState<CellEvent[]>([]);
  const cellIdRef = useRef(cellId);
  cellIdRef.current = cellId;
  useEffect(() => {
    if (cellId === null) {
      setEvents([]);
      return;
    }
    setEvents([]);
    const es = new EventSource(
      `/api/cells/${encodeURIComponent(cellId)}/events`,
    );
    es.addEventListener("message", (ev) => {
      // Guard: a slow SSE response from a previously-selected cell
      // could land after the user picked a different cell.
      if (cellIdRef.current !== cellId) return;
      try {
        const evt = JSON.parse(ev.data) as CellEvent;
        setEvents((prev) => [...prev, evt]);
      } catch {
        // Skip malformed lines.
      }
    });
    return () => es.close();
  }, [cellId]);
  return events;
}
