/**
 * Eval-score sidecar reader. Returns the array when the harness
 * wrote ``eval_scores.json`` (with at least one score), or null
 * when the sidecar is absent. The frontend renders the null case
 * as an empty state.
 *
 * Refresh-keyed alongside artifact / commits / detail so a sidecar
 * write that lands mid-run gets picked up on the next debounced
 * refetch.
 */
import { useEffect, useState } from "react";

import type { EvalScore } from "../lib/types";

export function useEvalScores(
  cellId: string | null,
  refreshKey: number,
): EvalScore[] | null {
  const [scores, setScores] = useState<EvalScore[] | null>(null);
  useEffect(() => {
    if (cellId === null) {
      setScores(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/cells/${encodeURIComponent(cellId)}/eval`)
      .then((r) => (r.ok ? r.json() : { scores: null }))
      .then((data) => {
        if (!cancelled) {
          setScores((data as { scores: EvalScore[] | null }).scores);
        }
      })
      .catch(() => {
        if (!cancelled) setScores(null);
      });
    return () => {
      cancelled = true;
    };
  }, [cellId, refreshKey]);
  return scores;
}
