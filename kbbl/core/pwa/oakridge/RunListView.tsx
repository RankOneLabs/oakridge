import { useQueryClient } from "@tanstack/react-query";
import { useRuns } from "./hooks";
import type { RunSummary } from "./types";
import { formatRelative } from "../lib/time";

function statusClass(run: RunSummary): string {
  if (run.is_failed || run.status === "failed") return "or-run-row--failed";
  if (run.status === "parked") return "or-run-row--parked";
  if (run.is_stuck) return "or-run-row--stuck";
  if (run.status === "complete") return "or-run-row--complete";
  return "or-run-row--running";
}

interface RunListViewProps {
  onSelectRun: (id: string) => void;
}

export function RunListView({ onSelectRun }: RunListViewProps) {
  const qc = useQueryClient();
  const query = useRuns();

  const onRefresh = () => {
    void qc.invalidateQueries({ queryKey: ["oakridge", "runs"] });
  };

  return (
    <div className="or-run-list" data-testid="or-run-list">
      <div className="or-run-list__header">
        <h2 className="or-run-list__title">Workflow Runs</h2>
        <button
          type="button"
          className="or-btn or-btn--secondary"
          onClick={onRefresh}
          aria-label="Refresh runs"
        >
          Refresh
        </button>
      </div>

      {query.isError && (
        <div className="or-error" role="alert" data-testid="or-run-list-error">
          {query.error instanceof Error ? query.error.message : "Failed to load runs"}
        </div>
      )}

      {query.isPending && !query.data && (
        <div className="or-loading" data-testid="or-run-list-loading">Loading runs…</div>
      )}

      {query.data && query.data.length === 0 && (
        <div className="or-empty" data-testid="or-run-list-empty">No workflow runs found.</div>
      )}

      {query.data && query.data.length > 0 && (
        <table className="or-table" aria-label="Workflow runs">
          <thead>
            <tr>
              <th>Workflow</th>
              <th>Status</th>
              <th>Stage</th>
              <th>Parked</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {query.data.map((run) => (
              <tr
                key={run.id}
                className={`or-run-row ${statusClass(run)}`}
                data-testid="or-run-row"
                onClick={() => onSelectRun(run.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onSelectRun(run.id); }}
              >
                <td className="or-run-row__name">{run.workflow_name}</td>
                <td className="or-run-row__status">
                  <span className={`or-chip or-chip--${run.status}`}>
                    {run.is_stuck ? "stuck" : run.is_failed ? "failed" : run.status}
                  </span>
                </td>
                <td className="or-run-row__stage">{run.current_stage ?? "—"}</td>
                <td className="or-run-row__parked">
                  {run.parked_count > 0 && (
                    <span className="or-badge or-badge--parked" data-testid="or-parked-count">
                      {run.parked_count}
                    </span>
                  )}
                </td>
                <td className="or-run-row__updated">{formatRelative(run.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
