/**
 * Live run list. Polls /api/runs every 2s (mirrors useCells.ts).
 * Exposes cancel(runId) which issues DELETE /api/runs/:runId then
 * immediately refreshes so the strip reflects the transition.
 */
import { useCallback, useEffect, useState } from "react";

import { RunsResponseSchema } from "../lib/types";
import type { RunSummary } from "../lib/types";

export function useRuns(): {
  runs: RunSummary[];
  refresh: () => Promise<void>;
  cancel: (runId: string) => Promise<void>;
} {
  const [runs, setRuns] = useState<RunSummary[]>([]);

  const refresh = useCallback(async () => {
    const r = await fetch("/api/runs");
    if (!r.ok) return;
    const data = RunsResponseSchema.parse(await r.json());
    setRuns(data.runs);
  }, []);

  const cancel = useCallback(
    async (runId: string) => {
      await fetch(`/api/runs/${encodeURIComponent(runId)}`, {
        method: "DELETE",
      });
      await refresh();
    },
    [refresh],
  );

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  return { runs, refresh, cancel };
}
