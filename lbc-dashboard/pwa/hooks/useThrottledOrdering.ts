/**
 * Stabilizes the session-list ordering.
 *
 * The backend returns cells sorted by last activity, so a cell jumps to the
 * top the instant it emits an event. With the 2s /api/cells poll that means
 * the list visibly reshuffles while you're reading it. This keeps each cell's
 * content fresh on every poll but only re-applies the sort *order* on a fixed
 * cadence (default 10s), so existing rows hold their position between
 * snapshots.
 *
 * Cells whose ids aren't in the current snapshot yet (a freshly launched run)
 * are surfaced immediately at the top — where new activity sorts anyway — so
 * appearance is never delayed; only the churn among already-listed cells is
 * throttled. Removed cells drop out as soon as they leave the poll response.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import type { CellId } from "../lib/ids";
import type { CellSummary } from "../lib/types";

export function useThrottledOrdering(
  cells: CellSummary[],
  intervalMs = 10000,
): CellSummary[] {
  // Display order, as cell ids. Recomputed from the latest poll on a timer.
  const [order, setOrder] = useState<CellId[]>(() =>
    cells.map((c) => c.cell_id),
  );

  // The timer reads the freshest cells without re-arming on every poll.
  const cellsRef = useRef(cells);
  cellsRef.current = cells;

  useEffect(() => {
    const t = setInterval(() => {
      setOrder(cellsRef.current.map((c) => c.cell_id));
    }, intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);

  // Seed the order as soon as the first cells arrive (the initial poll lands
  // after mount, when order is still empty). Without this every cell would
  // count as a newcomer and the list would re-sort each poll until the first
  // 10s snapshot. Re-seeds the same way if the list ever empties out.
  const empty = order.length === 0 && cells.length > 0;
  useEffect(() => {
    if (empty) setOrder(cellsRef.current.map((c) => c.cell_id));
  }, [empty]);

  return useMemo(() => {
    const byId = new Map(cells.map((c) => [c.cell_id, c]));
    const inOrder = new Set(order);
    // Newcomers (not in the last snapshot) go on top in backend sort order.
    const newcomers = cells.filter((c) => !inOrder.has(c.cell_id));
    const existing = order
      .map((id) => byId.get(id))
      .filter((c): c is CellSummary => c !== undefined);
    return [...newcomers, ...existing];
  }, [cells, order]);
}
