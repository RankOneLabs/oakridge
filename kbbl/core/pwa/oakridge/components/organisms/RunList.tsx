import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRuns } from "../../hooks/useRuns";
import type { RunSummary } from "../../types";
import { formatRelative } from "../../../lib/time";
import { GlobalParkedGateList } from "../../ParkedGateList";
import { Button } from "../atoms/Button";
import { FeedbackMessage } from "../atoms/FeedbackMessage";
import { PageHeader } from "../molecules/PageHeader";

type FilterTab = "all" | "active" | "parked" | "complete" | "archived";

function applyTabFilter(runs: RunSummary[], tab: FilterTab): RunSummary[] {
  switch (tab) {
    case "active": return runs.filter((r) => r.status === "pending" || r.status === "running" || r.status === "parked");
    case "parked": return runs.filter((r) => r.status === "parked");
    case "complete": return runs.filter((r) => r.status === "complete" || r.status === "failed" || r.status === "cancelled");
    default: return runs;
  }
}

type RunDisplayStatus = "failed" | "stuck" | RunSummary["status"];

const tableHeaderClass =
  "border-b border-[var(--border-subtle)] px-3 py-2 text-left text-xs font-semibold uppercase text-[var(--text-muted)]";
const tableCellClass =
  "border-b border-[var(--border-subtle)] px-3 py-2.5 align-middle";
function displayStatus(run: RunSummary): RunDisplayStatus {
  if (run.is_failed || run.status === "failed") return "failed";
  if (run.is_stuck) return "stuck";
  return run.status;
}

function statusRowClass(status: RunDisplayStatus): string {
  return `or-run-row or-run-row--${status}`;
}

function statusChipClass(status: RunDisplayStatus): string {
  return `or-chip or-chip--${status}`;
}

interface RunListProps {
  onSelectRun: (id: string) => void;
  onNewRun: () => void;
  onNewProject: () => void;
  onReviewInbox?: () => void;
  onSelectArtifact?: (id: string) => void;
}

const FILTER_TABS: { key: FilterTab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "parked", label: "Parked" },
  { key: "complete", label: "Complete" },
  { key: "archived", label: "Archived" },
];

export function RunList({ onSelectRun, onNewRun, onNewProject, onReviewInbox, onSelectArtifact }: RunListProps) {
  const [activeTab, setActiveTab] = useState<FilterTab>("all");
  const qc = useQueryClient();
  const apiFilter = activeTab === "archived" ? "archived" : undefined;
  const query = useRuns(apiFilter);

  const onRefresh = () => {
    void qc.invalidateQueries({ queryKey: ["oakridge", "runs"] });
  };

  const visibleRuns = applyTabFilter(query.data ?? [], activeTab);

  return (
    <div className="or-page or-page--wide" data-testid="or-run-list">
      {onSelectArtifact && <div className="mb-6">
        <GlobalParkedGateList
          onNavigateRun={onSelectRun}
          onNavigateArtifact={onSelectArtifact}
        />
      </div>}
      <PageHeader
        eyebrow="Workflow operations"
        title="Runs"
        summary="Monitor active work, review parked decisions, and inspect completed workflows."
        actions={
          <>
            {onReviewInbox && <Button onClick={onReviewInbox} data-testid="or-review-inbox-btn">Review inbox</Button>}
            <Button onClick={onNewProject} data-testid="or-new-project-btn">+ Project</Button>
            <Button onClick={onNewRun} data-testid="or-new-run-btn">+ New Run</Button>
            <Button onClick={onRefresh} aria-label="Refresh runs">Refresh</Button>
          </>
        }
      />

      <div className="mb-3 flex gap-1 border-b border-[var(--border-subtle)]" role="tablist">
        {FILTER_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.key}
            className={
              activeTab === tab.key
                ? "border-b-2 border-[var(--accent-blue)] px-3 py-1.5 text-sm font-medium text-[var(--accent-blue)]"
                : "px-3 py-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
            }
            onClick={() => setActiveTab(tab.key)}
            data-testid={`or-filter-tab-${tab.key}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {query.isError && (
        <FeedbackMessage tone="danger" testId="or-run-list-error">
          {query.error instanceof Error ? query.error.message : "Failed to load runs"}
        </FeedbackMessage>
      )}

      {query.isPending && !query.data && (
        <FeedbackMessage testId="or-run-list-loading">Loading runs…</FeedbackMessage>
      )}

      {query.data && visibleRuns.length === 0 && (
        <FeedbackMessage testId="or-run-list-empty">No workflow runs found.</FeedbackMessage>
      )}

      {visibleRuns.length > 0 && (
        <table className="or-data-table w-full border-collapse text-sm" aria-label="Workflow runs">
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
            {visibleRuns.map((run) => {
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
