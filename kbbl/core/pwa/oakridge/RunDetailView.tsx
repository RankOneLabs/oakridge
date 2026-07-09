import { useQueryClient } from "@tanstack/react-query";
import { useRun, useCancelRun, useRetryStuck } from "./hooks";
import type { StageDetail } from "./types";
import { RunParkedGateList } from "./ParkedGateList";

const secondaryButtonClass =
  "inline-flex items-center gap-1.5 rounded-md border border-[var(--border-muted)] bg-transparent px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:border-[var(--border-hover)]";
const tableHeaderClass =
  "border-b border-[var(--border-subtle)] px-3 py-2 text-left text-xs font-semibold uppercase text-[var(--text-muted)]";
const tableCellClass =
  "border-b border-[var(--border-subtle)] px-3 py-2.5 align-middle";
const chipBaseClass =
  "inline-block rounded border bg-[var(--bg-surface)] px-2 py-0.5 text-xs font-medium";
const codeClass =
  "rounded bg-[var(--bg-code)] px-1.5 py-0.5 font-mono text-xs text-[var(--text-secondary)]";
const mutedClass = "text-sm text-[var(--text-muted)]";

function statusChipClass(status: string): string {
  if (status === "failed") return `${chipBaseClass} border-red-500 text-red-500`;
  if (status === "parked") return `${chipBaseClass} border-amber-500 text-amber-500`;
  if (status === "complete") return `${chipBaseClass} border-emerald-500 text-emerald-500`;
  if (status === "running") return `${chipBaseClass} border-blue-500 text-blue-500`;
  return `${chipBaseClass} border-[var(--border-muted)] text-[var(--text-muted)]`;
}

function stageRowClass(status: string): string {
  const base = "transition-colors hover:bg-[var(--bg-elevated)]";
  if (status === "failed") return `${base} opacity-80`;
  if (status === "parked") return `${base} border-l-2 border-l-amber-500`;
  return base;
}

interface StageRowProps {
  stage: StageDetail;
  canRetry: boolean;
  onRetry: (stageInstanceId: string) => void;
  retrying: boolean;
  onSelectArtifact?: (artifactId: string) => void;
}

function StageRow({ stage, canRetry, onRetry, retrying, onSelectArtifact }: StageRowProps) {
  return (
    <tr className={stageRowClass(stage.status)} data-testid="or-stage-row">
      <td className={`${tableCellClass} font-medium text-[var(--text-primary)]`} data-testid="or-stage-name">
        {stage.name}
      </td>
      <td className={`${tableCellClass} text-[var(--text-secondary)]`}>{stage.type}</td>
      <td className={tableCellClass}>
        <div className="flex items-center gap-2">
          <span className={statusChipClass(stage.status)}>{stage.status}</span>
          {canRetry && stage.status === "parked" && (
            <button
              type="button"
              className="rounded border border-amber-400 px-2 py-0.5 text-xs text-amber-400 hover:bg-amber-400 hover:text-black disabled:opacity-50"
              onClick={() => onRetry(stage.stage_instance_id)}
              disabled={retrying}
              data-testid="or-retry-stuck-btn"
            >
              {retrying ? "…" : "Retry"}
            </button>
          )}
        </div>
      </td>
      <td className={tableCellClass}>
        {stage.artifacts.length === 0 && <span className={mutedClass}>-</span>}
        <div className="flex flex-wrap gap-1.5">
          {stage.artifacts.map((artifact) => (
            <button
              key={artifact.id}
              type="button"
              className={`${chipBaseClass} border-[var(--accent-blue)] text-[var(--accent-blue)] underline`}
              onClick={() => onSelectArtifact?.(artifact.id)}
            >
              {artifact.type_id}
            </button>
          ))}
        </div>
      </td>
      <td className={tableCellClass} data-testid="or-stage-session">
        {stage.delegated_kbbl_sid ? (
          <a
            href={`#sid=${encodeURIComponent(stage.delegated_kbbl_sid)}`}
            className="text-[var(--accent-blue)] underline"
            data-testid="or-delegated-session-link"
          >
            {stage.delegated_kbbl_sid.slice(0, 8)}
          </a>
        ) : (
          <span className={mutedClass}>-</span>
        )}
      </td>
      <td className={tableCellClass} data-testid="or-stage-worktree">
        {stage.worktree ? (
          <div className="flex flex-col gap-1">
            <code className={codeClass} data-testid="or-stage-branch">
              {stage.worktree.branch}
            </code>
            <code className={codeClass} data-testid="or-stage-path">
              {stage.worktree.path}
            </code>
          </div>
        ) : (
          <span className={mutedClass}>-</span>
        )}
      </td>
    </tr>
  );
}

interface RunDetailViewProps {
  runId: string;
  onBack: () => void;
  onSelectArtifact: (artifactId: string) => void;
}

export function RunDetailView({ runId, onBack, onSelectArtifact }: RunDetailViewProps) {
  const qc = useQueryClient();
  const query = useRun(runId);
  const cancelMutation = useCancelRun(runId);
  const retryMutation = useRetryStuck(runId);

  const onRefresh = () => {
    void qc.invalidateQueries({ queryKey: ["oakridge", "run", runId] });
    void qc.invalidateQueries({ queryKey: ["oakridge", "run", runId, "gates"] });
  };

  if (query.isError) {
    return (
      <div className="flex flex-col gap-5" data-testid="or-run-detail">
        <button type="button" className={secondaryButtonClass} onClick={onBack}>Back</button>
        <div
          className="rounded-md border border-[var(--danger-card-border)] bg-[var(--danger-bg)] px-4 py-3 text-sm text-[var(--danger-fg)]"
          role="alert"
          data-testid="or-run-detail-error"
        >
          {query.error instanceof Error ? query.error.message : "Failed to load run"}
        </div>
      </div>
    );
  }

  if (query.isPending || !query.data) {
    return (
      <div className="flex flex-col gap-5" data-testid="or-run-detail">
        <button type="button" className={secondaryButtonClass} onClick={onBack}>Back</button>
        <div className="py-6 text-sm text-[var(--text-muted)]">Loading run…</div>
      </div>
    );
  }

  const run = query.data;

  const canCancel = run.status === "running" || run.status === "parked";

  return (
    <div className="flex flex-col gap-5" data-testid="or-run-detail">
      <header className="flex items-start gap-4">
        <button type="button" className={secondaryButtonClass} onClick={onBack}>Back</button>
        <div className="flex-1">
          <h2 className="mb-1.5 mt-0 text-lg font-semibold text-[var(--text-primary)]" data-testid="or-run-detail-title">
            {run.workflow_name}
          </h2>
          <div className="flex flex-wrap gap-2">
            <span className={statusChipClass(run.status)} data-testid="or-run-detail-status">
              {run.status}
            </span>
            {run.parked_count > 0 && (
              <span
                className="inline-flex h-5 items-center rounded-full bg-amber-500 px-2 text-[11px] font-semibold text-black"
                data-testid="or-run-detail-parked"
              >
                {run.parked_count} parked
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canCancel && (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-red-500 px-3 py-1.5 text-sm text-red-500 hover:bg-red-500 hover:text-white disabled:opacity-50"
              onClick={() => void cancelMutation.mutate()}
              disabled={cancelMutation.isPending}
              data-testid="or-cancel-run-btn"
            >
              {cancelMutation.isPending ? "Cancelling…" : "Cancel Run"}
            </button>
          )}
          <button type="button" className={secondaryButtonClass} onClick={onRefresh}>
            Refresh
          </button>
        </div>
      </header>

      <section className="flex flex-col">
        <h3 className="mb-3 mt-0 text-sm font-semibold text-[var(--text-secondary)]">Stages</h3>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm" aria-label="Stage timeline">
            <thead>
              <tr>
                <th className={tableHeaderClass}>Stage</th>
                <th className={tableHeaderClass}>Type</th>
                <th className={tableHeaderClass}>Status</th>
                <th className={tableHeaderClass}>Artifacts</th>
                <th className={tableHeaderClass}>Session</th>
                <th className={tableHeaderClass}>Worktree</th>
              </tr>
            </thead>
            <tbody>
              {run.stages.map((stage: StageDetail) => (
                <StageRow
                  key={stage.name}
                  stage={stage}
                  canRetry={run.is_stuck}
                  onRetry={(sid) => void retryMutation.mutate(sid)}
                  retrying={retryMutation.isPending}
                  onSelectArtifact={onSelectArtifact}
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <RunParkedGateList runId={runId} />
    </div>
  );
}
