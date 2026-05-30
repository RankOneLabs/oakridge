/**
 * Horizontal strip showing all tracked runs (most-recent first).
 * Each row shows target × condition label, a RunStatusPill, and a
 * Cancel button enabled only while status === 'running'.
 */
import { useRuns } from "../../hooks/useRuns";
import { RunStatusPill } from "../atoms/RunStatusPill";

export function ActiveRunsStrip() {
  const { runs, cancel } = useRuns();

  if (runs.length === 0) {
    return (
      <p className="px-4 py-2 text-sm italic text-stone-400">No active runs.</p>
    );
  }

  const sorted = [...runs].sort((a, b) => b.started_ms - a.started_ms);

  return (
    <ul className="flex flex-wrap gap-2 px-4 pb-3">
      {sorted.map((run) => {
        const condLabel =
          run.condition.kind === "single_agent"
            ? run.condition.kind
            : `${run.condition.kind}_n${run.condition.n}`;
        return (
          <li
            key={run.runId}
            className="flex items-center gap-2 rounded border border-stone-200 bg-stone-50 px-3 py-1.5 text-sm"
          >
            <span className="font-medium text-stone-700">
              {run.target} × {condLabel}
            </span>
            <RunStatusPill status={run.status} />
            <button
              type="button"
              className="ml-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={run.status !== "running"}
              onClick={() => void cancel(run.runId)}
            >
              cancel
            </button>
          </li>
        );
      })}
    </ul>
  );
}
