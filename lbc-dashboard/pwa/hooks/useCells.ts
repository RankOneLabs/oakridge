/**
 * Live cell list. Polls /api/cells every 2s so newly-spawned cells
 * appear without manual reload. Cheap; the endpoint is stat-driven.
 */
import { useCallback, useEffect, useState } from "react";

import type { CellSummary } from "../lib/types";

export function useCells(): {
  cells: CellSummary[];
  refresh: () => Promise<void>;
} {
  const [cells, setCells] = useState<CellSummary[]>([]);
  const refresh = useCallback(async () => {
    const r = await fetch("/api/cells");
    if (!r.ok) return;
    const data = (await r.json()) as { cells: CellSummary[] };
    setCells(data.cells);
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);
  return { cells, refresh };
}
