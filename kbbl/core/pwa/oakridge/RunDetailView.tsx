import { useQueryClient } from "@tanstack/react-query";
import { useRun } from "./hooks";
import type { StageDetail } from "./types";
import { RunParkedGateList } from "./ParkedGateList";

function stageStatusClass(status: string): string {
  return `or-stage-row--${status}`;
}

interface StageRowProps {
  stage: StageDetail;
  onSelectArtifact?: (typeId: string) => void;
}

function StageRow({ stage, onSelectArtifact }: StageRowProps) {
  return (
    <tr className={`or-stage-row ${stageStatusClass(stage.status)}`} data-testid="or-stage-row">
      <td className="or-stage-row__name" data-testid="or-stage-name">{stage.name}</td>
      <td className="or-stage-row__type">{stage.type}</td>
      <td className="or-stage-row__status">
        <span className={`or-chip or-chip--${stage.status}`}>{stage.status}</span>
      </td>
      <td className="or-stage-row__artifacts">
        {stage.artifact_types.length === 0 && <span className="or-muted">—</span>}
        {stage.artifact_types.map((t) => (
          <button
            key={t}
            type="button"
            className="or-chip or-chip--artifact or-link"
            onClick={() => onSelectArtifact?.(t)}
          >
            {t}
          </button>
        ))}
      </td>
      <td className="or-stage-row__session" data-testid="or-stage-session">
        {stage.delegated_kbbl_sid ? (
          <a
            href={`#sid=${encodeURIComponent(stage.delegated_kbbl_sid)}`}
            className="or-link"
            data-testid="or-delegated-session-link"
          >
            {stage.delegated_kbbl_sid.slice(0, 8)}
          </a>
        ) : (
          <span className="or-muted">—</span>
        )}
      </td>
      <td className="or-stage-row__worktree" data-testid="or-stage-worktree">
        {stage.worktree ? (
          <div className="or-worktree-meta">
            <code className="or-code" data-testid="or-stage-branch">{stage.worktree.branch}</code>
            <code className="or-code" data-testid="or-stage-path">{stage.worktree.path}</code>
          </div>
        ) : (
          <span className="or-muted">—</span>
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

  const onRefresh = () => {
    void qc.invalidateQueries({ queryKey: ["oakridge", "run", runId] });
    void qc.invalidateQueries({ queryKey: ["oakridge", "run", runId, "gates"] });
  };

  if (query.isError) {
    return (
      <div className="or-run-detail" data-testid="or-run-detail">
        <button type="button" className="or-btn or-btn--secondary" onClick={onBack}>← Back</button>
        <div className="or-error" role="alert" data-testid="or-run-detail-error">
          {query.error instanceof Error ? query.error.message : "Failed to load run"}
        </div>
      </div>
    );
  }

  if (query.isPending || !query.data) {
    return (
      <div className="or-run-detail" data-testid="or-run-detail">
        <button type="button" className="or-btn or-btn--secondary" onClick={onBack}>← Back</button>
        <div className="or-loading">Loading run…</div>
      </div>
    );
  }

  const run = query.data;

  return (
    <div className="or-run-detail" data-testid="or-run-detail">
      <header className="or-run-detail__header">
        <button type="button" className="or-btn or-btn--secondary" onClick={onBack}>← Back</button>
        <div className="or-run-detail__title-block">
          <h2 className="or-run-detail__title" data-testid="or-run-detail-title">
            {run.workflow_name}
          </h2>
          <div className="or-run-detail__chips">
            <span className={`or-chip or-chip--${run.status}`} data-testid="or-run-detail-status">
              {run.status}
            </span>
            {run.parked_count > 0 && (
              <span className="or-badge or-badge--parked" data-testid="or-run-detail-parked">
                {run.parked_count} parked
              </span>
            )}
          </div>
        </div>
        <button type="button" className="or-btn or-btn--secondary" onClick={onRefresh}>
          Refresh
        </button>
      </header>

      <section className="or-run-detail__stages">
        <h3 className="or-section-title">Stages</h3>
        <div className="or-table-wrap">
          <table className="or-table or-stage-table" aria-label="Stage timeline">
            <thead>
              <tr>
                <th>Stage</th>
                <th>Type</th>
                <th>Status</th>
                <th>Artifacts</th>
                <th>Session</th>
                <th>Worktree</th>
              </tr>
            </thead>
            <tbody>
              {run.stages.map((stage: StageDetail) => (
                <StageRow
                  key={stage.name}
                  stage={stage}
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
