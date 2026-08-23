import type { OperatorRunStatus, OperatorStageStatus } from "../domain/operator-projections";
import type { StageOutcome } from "../domain/workflow";

/**
 * Operator status is two axes, not one.
 *
 * DBOS's workflow status is the *liveness* axis: is this workflow still
 * running, did it crash, was it cancelled. It is not the *result* axis —
 * the run and stage workflows return failure and cancellation as ordinary
 * values, which DBOS faithfully records as SUCCESS. A projection reading
 * only `dbos_status` therefore reports a failed stage as complete.
 *
 * So: a live workflow reports its liveness, and a finished one reports the
 * domain outcome it recorded. A finished workflow with no persisted outcome
 * predates outcome recording (or died between its last step and the write);
 * it stays "complete", which is the pre-existing behavior.
 */
export const selectStageStatus = (dbos_status: string, has_pending_gate: boolean, outcome: StageOutcome | null = null): OperatorStageStatus => {
  if (has_pending_gate) return "parked";
  if (dbos_status === "SUCCESS") return outcome === null || outcome.kind === "succeeded" ? "complete" : "failed";
  if (dbos_status === "ERROR" || dbos_status === "CANCELLED" || dbos_status === "MAX_RECOVERY_ATTEMPTS_EXCEEDED") return "failed";
  if (dbos_status === "ENQUEUED") return "pending";
  if (dbos_status === "PENDING") return "running";
  return "running";
};

export const selectRunStatus = (dbos_status: string, parked_count: number, outcome: StageOutcome | null = null): OperatorRunStatus => {
  if (parked_count > 0) return "parked";
  if (dbos_status === "SUCCESS") {
    if (outcome === null || outcome.kind === "succeeded") return "complete";
    return outcome.kind === "cancelled" ? "cancelled" : "failed";
  }
  if (dbos_status === "CANCELLED") return "cancelled";
  if (dbos_status === "ERROR" || dbos_status === "MAX_RECOVERY_ATTEMPTS_EXCEEDED") return "failed";
  if (dbos_status === "ENQUEUED") return "pending";
  return "running";
};
