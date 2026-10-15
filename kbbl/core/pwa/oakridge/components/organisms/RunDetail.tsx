import { useQueryClient } from "@tanstack/react-query";
import { useRun } from "../../hooks/useRun";
import { useCancelRun } from "../../hooks/useCancelRun";
import { useRetryStuck } from "../../hooks/useRetryStuck";
import { useArchiveRun } from "../../hooks/useArchiveRun";
import { useUnarchiveRun } from "../../hooks/useUnarchiveRun";
import { useDeleteRun } from "../../hooks/useDeleteRun";
import { useAdmitStageUnit } from "../../hooks/useAdmitStageUnit";
import { useConfirmCohortMerged } from "../../hooks/useConfirmCohortMerged";
import { useReviewInbox } from "../../hooks/useReviewInbox";
import { hasOpenPullRequestMergeWait } from "../../lib/run-overview";
import type { StageDetail } from "../../types";
import { RunParkedGateList } from "./ParkedGateList";
import { RunStageRow, RunUnitRow } from "../molecules/RunStageRows";
import { StatusBadge } from "../atoms/StatusBadge";
import { Button } from "../../../components/atoms/Button";
import { Chip } from "../../../components/atoms/Chip";
import { FeedbackMessage } from "../../../components/atoms/FeedbackMessage";
import { FinalIntegrationPanel } from "./FinalIntegrationPanel";

const tableHeaderClass =
  "border-b border-[var(--border-subtle)] px-3 py-2 text-left text-xs font-semibold uppercase text-[var(--text-muted)]";

function isFannedOut(stage: StageDetail): boolean {
  return (
    stage.units != null &&
    stage.units.length > 0 &&
    !(stage.units.length === 1 && stage.units[0].unit_id === "0")
  );
}

interface UnitRetryFacts {
  readonly isRunActive: boolean;
  readonly isRunStuck: boolean;
  readonly unitStatus: NonNullable<StageDetail["units"]>[number]["status"];
}

const canRetryUnit = ({ isRunActive, isRunStuck, unitStatus }: UnitRetryFacts): boolean =>
  isRunActive && (unitStatus === "failed" || (isRunStuck && unitStatus !== "complete"));

interface RunDetailProps {
  runId: string;
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

export function RunDetail({ runId, onRunDeleted, onSelectArtifact }: RunDetailProps) {
  const qc = useQueryClient();
  const query = useRun(runId);
  const cancelMutation = useCancelRun(runId);
  const retryMutation = useRetryStuck(runId);
  const archiveMutation = useArchiveRun(runId);
  const unarchiveMutation = useUnarchiveRun(runId);
  const deleteMutation = useDeleteRun(runId);
  const admitMutation = useAdmitStageUnit(runId);
  const confirmMergeMutation = useConfirmCohortMerged(runId);
  const reviewInboxQuery = useReviewInbox();

  const onRefresh = () => {
    void qc.invalidateQueries({ queryKey: ["oakridge", "run", runId] });
    void qc.invalidateQueries({ queryKey: ["oakridge", "run", runId, "gates"] });
  };

  if (query.isError) {
    return (
      <div className="or-page or-page--wide" data-testid="or-run-detail">
        <FeedbackMessage tone="danger" testId="or-run-detail-error">
          {query.error instanceof Error ? query.error.message : "Failed to load run"}
        </FeedbackMessage>
      </div>
    );
  }

  if (query.isPending || !query.data) {
    return (
      <div className="or-page or-page--wide" data-testid="or-run-detail">
        <FeedbackMessage>Loading run…</FeedbackMessage>
      </div>
    );
  }

  const run = query.data;

  const canCancel = run.status === "running" || run.status === "parked";
  const isRunActive = run.status === "running" || run.status === "parked";

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
                    const cohortId = `${stage.stage_instance_id}:${unit.unit_id}`;
                    const canConfirmMerge = hasOpenPullRequestMergeWait({
                      items: reviewInboxQuery.data?.items ?? [],
                      runId,
                      stageInstanceId: stage.stage_instance_id,
                      unitId: unit.unit_id,
                    });
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
                        onRetry={(unitId) => void retryMutation.mutate({ stageInstanceId: stage.stage_instance_id, unitId })}
                        retrying={retryMutation.isPending
                          && retryMutation.variables?.stageInstanceId === stage.stage_instance_id
                          && retryMutation.variables.unitId === unit.unit_id}
                        retryError={retryMutation.isError
                          && retryMutation.variables?.stageInstanceId === stage.stage_instance_id
                          && retryMutation.variables.unitId === unit.unit_id
                          ? (retryMutation.error instanceof Error ? retryMutation.error.message : "Retry failed")
                          : undefined}
                        canRetry={canRetryUnit({ isRunActive, isRunStuck: run.is_stuck, unitStatus: unit.status })}
                        confirmMerge={canConfirmMerge ? {
                          onConfirm: () => confirmMergeMutation.mutate({
                            cohortId,
                            operatorComment: "Operator confirmed the pull request merged from the run workspace",
                          }),
                          isConfirming: confirmMergeMutation.isPending
                            && confirmMergeMutation.variables?.cohortId === cohortId,
                          error: confirmMergeMutation.isError
                            && confirmMergeMutation.variables?.cohortId === cohortId
                            ? (confirmMergeMutation.error instanceof Error
                              ? confirmMergeMutation.error.message
                              : "Could not confirm the merge")
                            : undefined,
                        } : undefined}
                      />
                    );
                  });
                }
                const unit = units?.length === 1 ? units[0] : undefined;
                const shouldOfferRetry = unit !== undefined
                  && canRetryUnit({ isRunActive, isRunStuck: run.is_stuck, unitStatus: unit.status });
                return [
            <RunStageRow
                    key={stage.name}
                    stage={stage}
                    onSelectArtifact={onSelectArtifact}
                    retry={shouldOfferRetry ? {
                      onRetry: () => void retryMutation.mutate({ stageInstanceId: stage.stage_instance_id, unitId: unit.unit_id }),
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

      <RunParkedGateList runId={runId} />
    </div>
  );
}
