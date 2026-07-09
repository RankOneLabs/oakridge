import { useQueryClient } from "@tanstack/react-query";
import { useRuns } from "./hooks";
import type { RunSummary } from "./types";
import { formatRelative } from "../lib/time";

type RunDisplayStatus = "failed" | "stuck" | RunSummary["status"];

const secondaryButtonClass =
  "inline-flex items-center gap-1.5 rounded-md border border-[var(--border-muted)] bg-transparent px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:border-[var(--border-hover)]";
const tableHeaderClass =
  "border-b border-[var(--border-subtle)] px-3 py-2 text-left text-xs font-semibold uppercase text-[var(--text-muted)]";
const tableCellClass =
  "border-b border-[var(--border-subtle)] px-3 py-2.5 align-middle";
const chipBaseClass =
  "inline-block rounded border bg-[var(--bg-surface)] px-2 py-0.5 text-xs font-medium";

function displayStatus(run: RunSummary): RunDisplayStatus {
  if (run.is_failed || run.status === "failed") return "failed";
  if (run.is_stuck) return "stuck";
  return run.status;
}

function statusRowClass(status: RunDisplayStatus): string {
  const base = "cursor-pointer transition-colors hover:bg-[var(--bg-elevated)]";
  if (status === "failed") return `${base} opacity-80`;
  if (status === "stuck") return `${base} border-l-2 border-l-amber-400`;
  if (status === "parked") return `${base} border-l-2 border-l-amber-500`;
  if (status === "complete") return `${base} opacity-90`;
  return base;
}

function statusChipClass(status: RunDisplayStatus): string {
  if (status === "failed") return `${chipBaseClass} border-red-500 text-red-500`;
  if (status === "stuck") return `${chipBaseClass} border-amber-400 text-amber-400`;
  if (status === "parked") return `${chipBaseClass} border-amber-500 text-amber-500`;
  if (status === "complete") return `${chipBaseClass} border-emerald-500 text-emerald-500`;
  if (status === "running") return `${chipBaseClass} border-blue-500 text-blue-500`;
  return `${chipBaseClass} border-[var(--border-muted)] text-[var(--text-muted)]`;
}

interface RunListViewProps {
  onSelectRun: (id: string) => void;
  onNewRun: () => void;
  onNewProject: () => void;
}

export function RunListView({ onSelectRun, onNewRun, onNewProject }: RunListViewProps) {
  const qc = useQueryClient();
  const query = useRuns();

  const onRefresh = () => {
    void qc.invalidateQueries({ queryKey: ["oakridge", "runs"] });
  };

  return (
    <div data-testid="or-run-list">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="m-0 text-lg font-semibold text-[var(--text-primary)]">Workflow Runs</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={onNewProject}
            data-testid="or-new-project-btn"
          >
            + Project
          </button>
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={onNewRun}
            data-testid="or-new-run-btn"
          >
            + New Run
          </button>
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={onRefresh}
            aria-label="Refresh runs"
          >
            Refresh
          </button>
        </div>
      </div>

      {query.isError && (
        <div
          className="rounded-md border border-[var(--danger-card-border)] bg-[var(--danger-bg)] px-4 py-3 text-sm text-[var(--danger-fg)]"
          role="alert"
          data-testid="or-run-list-error"
        >
          {query.error instanceof Error ? query.error.message : "Failed to load runs"}
        </div>
      )}

      {query.isPending && !query.data && (
        <div className="py-6 text-sm text-[var(--text-muted)]" data-testid="or-run-list-loading">
          Loading runs…
        </div>
      )}

      {query.data && query.data.length === 0 && (
        <div className="py-6 text-sm text-[var(--text-muted)]" data-testid="or-run-list-empty">
          No workflow runs found.
        </div>
      )}

      {query.data && query.data.length > 0 && (
        <table className="w-full border-collapse text-sm" aria-label="Workflow runs">
          <thead>
            <tr>
              <th className={tableHeaderClass}>Workflow</th>
              <th className={tableHeaderClass}>Status</th>
              <th className={tableHeaderClass}>Stage</th>
              <th className={tableHeaderClass}>Parked</th>
              <th className={tableHeaderClass}>Updated</th>
            </tr>
          </thead>
          <tbody>
            {query.data.map((run) => {
              const status = displayStatus(run);
              return (
                <tr
                  key={run.id}
                  className={statusRowClass(status)}
                  data-testid="or-run-row"
                  onClick={() => onSelectRun(run.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectRun(run.id);
                    }
                  }}
                >
                  <td className={`${tableCellClass} font-medium text-[var(--text-primary)]`}>
                    {run.workflow_name}
                  </td>
                  <td className={tableCellClass}>
                    <span className={statusChipClass(status)}>{status}</span>
                  </td>
                  <td className={`${tableCellClass} text-[var(--text-secondary)]`}>
                    {run.current_stage ?? "-"}
                  </td>
                  <td className={tableCellClass}>
                    {run.parked_count > 0 && (
                      <span
                        className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 px-1.5 text-[11px] font-semibold text-black"
                        data-testid="or-parked-count"
                      >
                        {run.parked_count}
                      </span>
                    )}
                  </td>
                  <td className={`${tableCellClass} whitespace-nowrap text-xs text-[var(--text-muted)]`}>
                    {formatRelative(run.updated_at)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
