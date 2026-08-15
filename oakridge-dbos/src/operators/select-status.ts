import type { OperatorRunStatus, OperatorStageStatus } from "../domain/operator-projections";

export const selectStageStatus = (dbos_status: string, has_pending_gate: boolean): OperatorStageStatus => {
  if (has_pending_gate) return "parked";
  if (dbos_status === "SUCCESS") return "complete";
  if (dbos_status === "ERROR" || dbos_status === "CANCELLED" || dbos_status === "MAX_RECOVERY_ATTEMPTS_EXCEEDED") return "failed";
  if (dbos_status === "ENQUEUED" || dbos_status === "PENDING") return "pending";
  return "running";
};

export const selectRunStatus = (dbos_status: string, parked_count: number): OperatorRunStatus => {
  if (parked_count > 0) return "parked";
  if (dbos_status === "SUCCESS") return "complete";
  if (dbos_status === "CANCELLED") return "cancelled";
  if (dbos_status === "ERROR" || dbos_status === "MAX_RECOVERY_ATTEMPTS_EXCEEDED") return "failed";
  return "running";
};
