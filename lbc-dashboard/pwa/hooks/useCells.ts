/**
 * Live cell list. Polls /api/cells every 2s so newly-spawned cells
 * appear without manual reload. Cheap; the endpoint is stat-driven.
 *
 * Accepts an optional archive filter that maps to the ?archived query
 * param. Changing the filter immediately re-fetches (filter is in the
 * useCallback deps, which causes the effect to restart).
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { CellSummary } from "../lib/types";
import type { CellArchiveFilter } from "../lib/types";

export function useCells(filter: CellArchiveFilter = "default"): {
  cells: CellSummary[];
  refresh: () => Promise<void>;
} {
  const [cells, setCells] = useState<CellSummary[]>([]);
  // The 2s poll and filter changes can both fire refresh(), so a slow
  // response for an old filter could land after a newer one and overwrite
  // state with the wrong filter's cells. Abort the in-flight request before
  // each new one so only the latest response calls setCells.
  const inFlight = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    const url =
      filter === "default" ? "/api/cells" : `/api/cells?archived=${filter}`;
    let r: Response;
    try {
      r = await fetch(url, { signal: controller.signal });
    } catch {
      // Aborted (superseded by a newer request) or network error — ignore.
      return;
    }
    if (!r.ok) return;
    const data = (await r.json()) as { cells: CellSummary[] };
    setCells(data.cells);
  }, [filter]);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => {
      void refresh();
    }, 2000);
    return () => {
      clearInterval(t);
      inFlight.current?.abort();
    };
  }, [refresh]);
  return { cells, refresh };
}
