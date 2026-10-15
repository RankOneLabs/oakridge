import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRuns } from "../../hooks/useRuns";
import type { RunDisplayStatus, RunSummary } from "../../types";
import { formatRelative } from "../../../lib/time";
import { GlobalParkedGateList } from "./ParkedGateList";
import { Button } from "../../../components/atoms/Button";
import { Chip } from "../../../components/atoms/Chip";
import { FeedbackMessage } from "../../../components/atoms/FeedbackMessage";
import { selectStatusTone } from "../../lib/status-tone";
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

// Tailwind v4's palette tokens differ from the previous status hexes.
const STATUS_COLOR_CLASS = {
  running: "[&&]:border-[#3b82f6] [&&]:text-[#3b82f6]",
  stuck: "[&&]:border-[#fbbf24] [&&]:text-[#fbbf24]",
  parked: "[&&]:border-[#f59e0b] [&&]:text-[#f59e0b]",
  failed: "[&&]:border-[#ef4444] [&&]:text-[#ef4444]",
  complete: "[&&]:border-[#10b981] [&&]:text-[#10b981]",
  cancelled: "[&&]:border-[var(--text-muted)]",
  pending: "[&&]:border-[var(--text-muted)]",
} satisfies Record<RunDisplayStatus, string>;

interface RunListProps {
  onSelectRun: (id: string) => void;
  onNewRun: () => void;
  onNewProject: () => void;
  onWorkflows?: () => void;
  onSelectArtifact?: (id: string) => void;
  runAttentionCounts?: ReadonlyMap<string, number>;
}

const FILTER_TABS: { key: FilterTab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "parked", label: "Parked" },
  { key: "complete", label: "Complete" },
  { key: "archived", label: "Archived" },
];

export function RunList({ onSelectRun, onNewRun, onNewProject, onWorkflows, onSelectArtifact, runAttentionCounts = new Map() }: RunListProps) {
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
            {onWorkflows && <Button className="max-[767px]:flex-[1_1_auto]" onClick={onWorkflows} data-testid="or-workflows-btn">Workflows</Button>}
            <Button className="max-[767px]:flex-[1_1_auto]" onClick={onNewProject} data-testid="or-new-project-btn">+ Project</Button>
            <Button variant="primary" className="max-[767px]:flex-[1_1_auto]" onClick={onNewRun} data-testid="or-new-run-btn">+ New Run</Button>
            <Button className="max-[767px]:flex-[1_1_auto]" onClick={onRefresh} aria-label="Refresh runs">Refresh</Button>
          </>
        }
      />

      <div className="mb-3 flex gap-1 border-b border-[var(--border-subtle)]" role="tablist">
        {FILTER_TABS.map((tab) => (
          <Button
            key={tab.key}
            variant="secondary"
            role="tab"
            aria-selected={activeTab === tab.key}
            onClick={() => setActiveTab(tab.key)}
            data-testid={`or-filter-tab-${tab.key}`}
          >
            {tab.label}
          </Button>
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
              <th className={tableHeaderClass}>Run</th>
              <th className={tableHeaderClass}>Repositories</th>
              <th className={tableHeaderClass}>Status</th>
              <th className={tableHeaderClass}>Progress</th>
              <th className={tableHeaderClass}>Attention</th>
              <th className={tableHeaderClass}>Waits</th>
              <th className={tableHeaderClass}>Updated</th>
            </tr>
          </thead>
          <tbody>
            {visibleRuns.map((run) => {
              const status = displayStatus(run);
              const attentionCount = runAttentionCounts.get(run.id) ?? 0;
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
                  <td className={tableCellClass}>
                    <div className="font-medium text-[var(--text-primary)]" data-testid="or-run-title">
                      {run.title ?? run.workflow_name}
                    </div>
                    {run.title && <div className="mt-0.5 text-xs text-[var(--text-muted)]">{run.workflow_name}</div>}
                  </td>
                  <td className={`${tableCellClass} text-[var(--text-secondary)]`} data-testid="or-run-repositories">
                    {run.repository_keys.length > 0 ? run.repository_keys.join(", ") : "-"}
                  </td>
                  <td className={tableCellClass}>
                    <Chip tone={selectStatusTone(status)} className={STATUS_COLOR_CLASS[status]}>{status}</Chip>
                  </td>
                  <td className={`${tableCellClass} text-[var(--text-secondary)]`}>
                    <div>{run.current_stage ?? "-"}</div>
                    <div className="or-run-progress">
                      <progress value={run.stage_complete} max={Math.max(1, run.stage_total)} aria-label={`${run.stage_complete} of ${run.stage_total} stages complete`} />
                      <span>{run.stage_complete}/{run.stage_total}</span>
                    </div>
                  </td>
                  <td className={tableCellClass}>
                    {attentionCount > 0 && (
                      <span className="or-run-attention" data-testid="or-run-attention-count">
                        {attentionCount}
                      </span>
                    )}
                  </td>
                  <td className={tableCellClass}>
                    {run.parked_count > 0 && (
                      <span className="or-run-waits">
                        <span data-testid="or-parked-count">{run.parked_count}</span>
                        {run.parked_count === 1 ? " wait" : " waits"}
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
