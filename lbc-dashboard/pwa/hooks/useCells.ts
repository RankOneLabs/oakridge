/**
 * Live cell list. Polls /api/cells every 2s so newly-spawned cells
 * appear without manual reload. Cheap; the endpoint is stat-driven.
 *
 * Accepts an optional archive filter that maps to the ?archived query
 * param. Changing the filter immediately re-fetches (filter is in the
 * useCallback deps, which causes the effect to restart).
 */
import { useCallback, useEffect, useState } from "react";

import type { CellSummary } from "../lib/types";
import type { CellArchiveFilter } from "../lib/types";

export function useCells(filter: CellArchiveFilter = "default"): {
  cells: CellSummary[];
  refresh: () => Promise<void>;
} {
  const [cells, setCells] = useState<CellSummary[]>([]);
  const refresh = useCallback(async () => {
    const url =
      filter === "default" ? "/api/cells" : `/api/cells?archived=${filter}`;
    const r = await fetch(url);
    if (!r.ok) return;
    const data = (await r.json()) as { cells: CellSummary[] };
    setCells(data.cells);
  }, [filter]);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);
  return { cells, refresh };
}
