import { useQueryClient } from "@tanstack/react-query";
import { useRun } from "../../hooks/useRun";
import { useCancelRun } from "../../hooks/useCancelRun";
import { useRetryStuck } from "../../hooks/useRetryStuck";
import { useArchiveRun } from "../../hooks/useArchiveRun";
import { useUnarchiveRun } from "../../hooks/useUnarchiveRun";
import { useDeleteRun } from "../../hooks/useDeleteRun";
import { useAdmitStageUnit } from "../../hooks/useAdmitStageUnit";
import type { StageDetail } from "../../types";
import { RunParkedGateList } from "../../ParkedGateList";
import { RunStageRow, RunUnitRow } from "../molecules/RunStageRows";
import { StatusBadge } from "../atoms/StatusBadge";
import { FinalIntegrationPanel } from "./FinalIntegrationPanel";

const secondaryButtonClass =
  "inline-flex items-center gap-1.5 rounded-md border border-[var(--border-muted)] bg-transparent px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:border-[var(--border-hover)]";
const tableHeaderClass =
  "border-b border-[var(--border-subtle)] px-3 py-2 text-left text-xs font-semibold uppercase text-[var(--text-muted)]";

function isFannedOut(stage: StageDetail): boolean {
  return (
    stage.units != null &&
    stage.units.length > 0 &&
    !(stage.units.length === 1 && stage.units[0].unit_id === "0")
  );
}

interface RunDetailProps {
  runId: string;
  onBack: () => void;
  onSelectArtifact: (artifactId: string) => void;
}

export function RunDetail({ runId, onBack, onSelectArtifact }: RunDetailProps) {
  const qc = useQueryClient();
  const query = useRun(runId);
  const cancelMutation = useCancelRun(runId);
  const retryMutation = useRetryStuck(runId);
  const archiveMutation = useArchiveRun(runId);
  const unarchiveMutation = useUnarchiveRun(runId);
  const deleteMutation = useDeleteRun(runId);
  const admitMutation = useAdmitStageUnit(runId);

  const onRefresh = () => {
    void qc.invalidateQueries({ queryKey: ["oakridge", "run", runId] });
    void qc.invalidateQueries({ queryKey: ["oakridge", "run", runId, "gates"] });
  };

  if (query.isError) {
    return (
      <div className="or-page or-page--wide" data-testid="or-run-detail">
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
      <div className="or-page or-page--wide" data-testid="or-run-detail">
        <button type="button" className={secondaryButtonClass} onClick={onBack}>Back</button>
        <div className="py-6 text-sm text-[var(--text-muted)]">Loading run…</div>
      </div>
    );
  }

  const run = query.data;

  const canCancel = run.status === "running" || run.status === "parked";

  return (
    <div className="or-page or-page--wide" data-testid="or-run-detail">
      <header className="or-page-header or-page-header--back">
        <button type="button" className={secondaryButtonClass} onClick={onBack}>Back</button>
        <div className="flex-1">
          <span className="or-page-kicker">Live workflow</span>
          <h2 className="or-page-title" data-testid="or-run-detail-title">
            {run.workflow_name}
          </h2>
          <div className="flex flex-wrap gap-2">
            <StatusBadge status={run.status} testId="or-run-detail-status" />
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
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => void archiveMutation.mutate()}
            disabled={archiveMutation.isPending}
            data-testid="or-archive-run-btn"
          >
            {archiveMutation.isPending ? "…" : "Archive"}
          </button>
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => void unarchiveMutation.mutate()}
            disabled={unarchiveMutation.isPending}
            data-testid="or-unarchive-run-btn"
          >
            {unarchiveMutation.isPending ? "…" : "Unarchive"}
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border border-red-800 px-3 py-1.5 text-sm text-red-800 hover:bg-red-800 hover:text-white disabled:opacity-50 dark:border-red-400 dark:text-red-400 dark:hover:bg-red-400 dark:hover:text-black"
            onClick={() => {
              if (window.confirm("Delete this run permanently? This cannot be undone.")) {
                void deleteMutation.mutate(undefined, { onSuccess: onBack });
              }
            }}
            disabled={deleteMutation.isPending}
            data-testid="or-delete-run-btn"
          >
            {deleteMutation.isPending ? "…" : "Delete"}
          </button>
          {deleteMutation.isError && (
            <span className="text-sm text-red-500" role="alert">
              {deleteMutation.error instanceof Error ? deleteMutation.error.message : "Delete failed"}
            </span>
          )}
          <button type="button" className={secondaryButtonClass} onClick={onRefresh}>
            Refresh
          </button>
        </div>
      </header>

      {run.epic_profile && <FinalIntegrationPanel runId={runId} profile={run.epic_profile} />}

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
              {run.stages.flatMap((stage: StageDetail) => {
                const units = stage.units;
                if (units != null && isFannedOut(stage)) {
                  return units.map((unit) => {
                    const unitArtifacts = stage.artifacts.filter(
                      (a) => a.label === unit.unit_id,
                    );
                    return (
                <RunUnitRow
                        key={`${stage.name}:${unit.unit_id}`}
                        stageName={stage.name}
                        stageType={stage.type}
                        unit={unit}
                        unitArtifacts={unitArtifacts}
                        onSelectArtifact={onSelectArtifact}
                        onAdmit={(unitId) => void admitMutation.mutate({ stageId: stage.stage_instance_id, unitId })}
                        admitting={admitMutation.isPending && admitMutation.variables?.stageId === stage.stage_instance_id && admitMutation.variables.unitId === unit.unit_id}
                        admissionError={admitMutation.isError
                          && admitMutation.variables?.stageId === stage.stage_instance_id
                          && admitMutation.variables.unitId === unit.unit_id
                          ? (admitMutation.error instanceof Error ? admitMutation.error.message : "Admission failed")
                          : undefined}
                      />
                    );
                  });
                }
                return [
            <RunStageRow
                    key={stage.name}
                    stage={stage}
                    canRetry={run.is_stuck}
                    onRetry={(sid) => void retryMutation.mutate(sid)}
                    retrying={
                      retryMutation.isPending &&
                      retryMutation.variables === stage.stage_instance_id
                    }
                    onSelectArtifact={onSelectArtifact}
                  />,
                ];
              })}
            </tbody>
          </table>
        </div>
      </section>

      <RunParkedGateList runId={runId} />
    </div>
  );
}
