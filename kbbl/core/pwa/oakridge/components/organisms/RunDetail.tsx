import { selectStageHasCohortRows, selectCohortArtifacts } from "../../lib/stage-unit-params";
import { useQueryClient } from "@tanstack/react-query";
import { useCancelRun } from "../../hooks/useCancelRun";
import { useRetryStuck } from "../../hooks/useRetryStuck";
import { useArchiveRun } from "../../hooks/useArchiveRun";
import { useUnarchiveRun } from "../../hooks/useUnarchiveRun";
import { useDeleteRun } from "../../hooks/useDeleteRun";
import { useConfirmCohortMerged } from "../../hooks/useConfirmCohortMerged";
import { useAbandonCohort } from "../../hooks/useAbandonCohort";
import type { PullRequestMergeWait, RunDiagnosisGate, RunDetail as RunDetailRecord, StageDetail } from "../../types";
import { RunParkedGateList } from "./ParkedGateList";
import { RunStageRow, RunUnitRow } from "../molecules/RunStageRows";
import { StatusBadge } from "../atoms/StatusBadge";
import { Button } from "../../../components/atoms/Button";
import { Chip } from "../../../components/atoms/Chip";

const tableHeaderClass =
  "border-b border-[var(--border-subtle)] px-3 py-2 text-left text-xs font-semibold uppercase text-[var(--text-muted)]";


interface RunDetailProps {
  runId: string;
  run: RunDetailRecord;
  activeGates: readonly RunDiagnosisGate[];
  mergeWaits: readonly PullRequestMergeWait[];
  /**
   * Leave the run entirely, because it no longer exists. Only the delete path
   * calls this: the stage list renders inside a workspace pane, so navigation
   * away from the run belongs to the identity header's `← Runs` and disposing
   * of the list itself belongs to the pane chrome's close. A Back control here
   * would be a third answer to a question two controls already answer — and
   * the wrong one, since it exits the whole command center rather than the pane
   * the operator clicked in.
   */
  onRunDeleted: () => void;
  onSelectArtifact: (artifactId: string) => void;
}

export function RunDetail({ runId, run, activeGates, mergeWaits, onRunDeleted, onSelectArtifact }: RunDetailProps) {
  const qc = useQueryClient();
  const cancelMutation = useCancelRun(runId);
  const retryMutation = useRetryStuck(runId);
  const archiveMutation = useArchiveRun(runId);
  const unarchiveMutation = useUnarchiveRun(runId);
  const deleteMutation = useDeleteRun(runId);
  const confirmMergeMutation = useConfirmCohortMerged(runId);
  const abandonMutation = useAbandonCohort(runId);

  const requestAbandon = (cohortId: string, label: string, observedVersion: number): void => {
    const detail = window.prompt(`Why abandon ${label}?`)?.trim();
    if (!detail || !window.confirm(`Abandon ${label}? This ends its active session.`)) return;
    abandonMutation.mutate({ cohortId, detail, observedVersion });
  };

  const onRefresh = () => {
    void qc.invalidateQueries({ queryKey: ["oakridge", "run", runId] });
    void qc.invalidateQueries({ queryKey: ["oakridge", "run", runId, "gates"] });
  };

  const canCancel = run.status === "active" || run.status === "blocked";

  return (
    <div className="or-page or-page--wide" data-testid="or-run-detail">
      <header className="or-page-header">
        <div className="flex-1">
          <span className="or-page-kicker">Live workflow</span>
          <h2 className="or-page-title" data-testid="or-run-detail-title">
            {run.workflow_name}
          </h2>
          <div className="flex flex-wrap gap-2">
            <StatusBadge status={run.status} testId="or-run-detail-status" />
            {run.status === "blocked" && (
              <Chip tone="warning" testId="or-run-detail-blocked-reason">
                {run.blocked_reason} · next: {run.next_actor}
              </Chip>
            )}
            {run.parked_count > 0 && (
              <Chip tone="warning" testId="or-run-detail-parked">
                {run.parked_count} parked
              </Chip>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canCancel && (
            <Button
              type="button"
              variant="danger"
              onClick={() => void cancelMutation.mutate()}
              disabled={cancelMutation.isPending}
              data-testid="or-cancel-run-btn"
            >
              {cancelMutation.isPending ? "Cancelling…" : "Cancel Run"}
            </Button>
          )}
          <Button
            type="button"
            variant="secondary"
            onClick={() => void archiveMutation.mutate()}
            disabled={archiveMutation.isPending}
            data-testid="or-archive-run-btn"
          >
            {archiveMutation.isPending ? "…" : "Archive"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => void unarchiveMutation.mutate()}
            disabled={unarchiveMutation.isPending}
            data-testid="or-unarchive-run-btn"
          >
            {unarchiveMutation.isPending ? "…" : "Unarchive"}
          </Button>
          <Button
            type="button"
            variant="danger-strong"
            onClick={() => {
              if (window.confirm("Delete this run permanently? This cannot be undone.")) {
                void deleteMutation.mutate(undefined, { onSuccess: onRunDeleted });
              }
            }}
            disabled={deleteMutation.isPending}
            data-testid="or-delete-run-btn"
          >
            {deleteMutation.isPending ? "…" : "Delete"}
          </Button>
          {deleteMutation.isError && (
            <span className="text-sm text-red-500" role="alert">
              {deleteMutation.error instanceof Error ? deleteMutation.error.message : "Delete failed"}
            </span>
          )}
          <Button type="button" variant="secondary" onClick={onRefresh}>
            Refresh
          </Button>
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
              {run.stages.flatMap((stage: StageDetail) => {
                const units = stage.units;
                if (units != null && selectStageHasCohortRows(stage, mergeWaits)) {
                  return units.map((unit) => {
                    const cohortId = unit.cohort_id;
                    const canConfirmMerge = mergeWaits.some((wait) => wait.cohort_id === cohortId);
                    const unitArtifacts = selectCohortArtifacts(stage, cohortId);
                    return (
                <RunUnitRow
                        key={`${stage.name}:${unit.unit_id}`}
                        stageName={stage.name}
                        stageType={stage.type}
                        unit={unit}
                        unitArtifacts={unitArtifacts}
                        onSelectArtifact={onSelectArtifact}
                        onRetry={(unitId, worker) => void retryMutation.mutate({ stageInstanceId: stage.stage_instance_id, unitId, worker, observedVersion: unit.version })}
                        retrying={retryMutation.isPending
                          && retryMutation.variables?.stageInstanceId === stage.stage_instance_id
                          && retryMutation.variables.unitId === unit.unit_id}
                        retryError={retryMutation.isError
                          && retryMutation.variables?.stageInstanceId === stage.stage_instance_id
                          && retryMutation.variables.unitId === unit.unit_id
                          ? (retryMutation.error instanceof Error ? retryMutation.error.message : "Retry failed")
                          : undefined}
                        canRetry={unit.retryable}
                        abandon={unit.status !== "complete" && unit.status !== "failed" && unit.status !== "cancelled" ? {
                          onAbandon: () => requestAbandon(cohortId, unit.unit_id, unit.version),
                          isAbandoning: abandonMutation.isPending && abandonMutation.variables?.cohortId === cohortId,
                          error: abandonMutation.isError && abandonMutation.variables?.cohortId === cohortId
                            ? (abandonMutation.error instanceof Error ? abandonMutation.error.message : "Abandon failed") : undefined,
                        } : undefined}
                        confirmMerge={canConfirmMerge ? {
                          onConfirm: () => confirmMergeMutation.mutate({
                            cohortId,
                          }),
                          isConfirming: confirmMergeMutation.isPending
                            && confirmMergeMutation.variables?.cohortId === cohortId,
                          error: confirmMergeMutation.isError
                            && confirmMergeMutation.variables?.cohortId === cohortId
                            ? (confirmMergeMutation.error instanceof Error
                              ? confirmMergeMutation.error.message
                              : "Could not recheck the merge")
                            : undefined,
                        } : undefined}
                      />
                    );
                  });
                }
                const unit = units?.length === 1 ? units[0] : undefined;
                const shouldOfferRetry = unit?.retryable === true;
                return [
            <RunStageRow
                    key={stage.name}
                    stage={stage}
                    unitState={unit?.state}
                    workers={unit?.workers ?? []}
                    onRetryWorker={(worker) => { if (unit) retryMutation.mutate({ stageInstanceId: stage.stage_instance_id, unitId: unit.unit_id, worker, observedVersion: unit.version }); }}
                    onSelectArtifact={onSelectArtifact}
                    abandon={unit && unit.status !== "complete" && unit.status !== "failed" && unit.status !== "cancelled" ? {
                      onAbandon: () => requestAbandon(unit.cohort_id, unit.unit_id, unit.version),
                      isAbandoning: abandonMutation.isPending && abandonMutation.variables?.cohortId === unit.cohort_id,
                      error: abandonMutation.isError && abandonMutation.variables?.cohortId === unit.cohort_id
                        ? (abandonMutation.error instanceof Error ? abandonMutation.error.message : "Abandon failed") : undefined,
                    } : undefined}
                    retry={shouldOfferRetry ? {
                      onRetry: () => void retryMutation.mutate({ stageInstanceId: stage.stage_instance_id, unitId: unit.unit_id, observedVersion: unit.version }),
                      isRetrying: retryMutation.isPending
                        && retryMutation.variables?.stageInstanceId === stage.stage_instance_id
                        && retryMutation.variables.unitId === unit.unit_id,
                      error: retryMutation.isError
                        && retryMutation.variables?.stageInstanceId === stage.stage_instance_id
                        && retryMutation.variables.unitId === unit.unit_id
                        ? (retryMutation.error instanceof Error ? retryMutation.error.message : "Retry failed")
                        : undefined,
                    } : undefined}
                  />,
                ];
              })}
            </tbody>
          </table>
        </div>
      </section>

      <RunParkedGateList gates={activeGates} />
    </div>
  );
}
