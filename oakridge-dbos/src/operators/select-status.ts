import type { OperatorRunStatus, OperatorStageStatus } from "../domain/operator-projections";
import type { RunState, UnitState } from "../domain/run-record";
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

/** V2 display status is selected exclusively from the run-owned record. */
export interface V2RunStatusFacts { readonly state: RunState; readonly parked_count: number; readonly has_materialized_stage: boolean }

export const selectV2RunStatus = ({ state, parked_count, has_materialized_stage }: V2RunStatusFacts): OperatorRunStatus => {
  if (state === "succeeded") return "complete";
  if (state === "failed") return "failed";
  if (state === "cancelled") return "cancelled";
  if (parked_count > 0) return "parked";
  return has_materialized_stage ? "running" : "pending";
};

/** A stage's persisted lifecycle and open waits are its complete status input. */
export const selectV2StageStatus = (state: RunState, has_open_wait: boolean): OperatorStageStatus => {
  if (state === "succeeded") return "complete";
  if (state === "failed" || state === "cancelled") return "failed";
  return has_open_wait ? "parked" : "running";
};

/** Unit rows share the existing stage-status vocabulary on the operator API. */
export const selectV2UnitStatus = (state: UnitState, has_open_wait: boolean): OperatorStageStatus => {
  if (state === "satisfied") return "complete";
  if (state === "failed" || state === "cancelled") return "failed";
  if (has_open_wait) return "parked";
  return state === "ready" ? "pending" : "running";
};
