import type { ExecutionId, StageInstanceId, UnitId, WorkflowRunId } from "./primitives";
import type { ExternalExecutionReference } from "./execution";

export interface UnitRerunTarget {
  readonly run_id: WorkflowRunId;
  readonly stage_instance_id: StageInstanceId;
  readonly unit_id: UnitId;
  readonly execution_id: ExecutionId;
  readonly execution_workflow_id: string;
  readonly stage_coordinator_workflow_id: string;
}

export type StageRerunState =
  | { readonly status: "waiting"; readonly stage_instance_id: StageInstanceId; readonly unit_id: UnitId; readonly failed_execution_workflow_id: string; readonly code: string; readonly detail: string | null }
  | { readonly status: "resumed"; readonly stage_instance_id: StageInstanceId; readonly unit_id: UnitId; readonly replacement_execution_workflow_id: string };

/**
 * Rerun state is published per unit, not per stage. A stage runs several units
 * at once, so a single event key would let the second failure overwrite the
 * first and leave that unit with no way for an operator to reach it.
 */
export const STAGE_RERUN_STATE_KEY_PREFIX = "stage-rerun-state:";
export const stageRerunStateKey = (unit_id: UnitId): string => `${STAGE_RERUN_STATE_KEY_PREFIX}${unit_id}`;

export interface CancellationExecutionTarget {
  readonly execution_id: ExecutionId;
  readonly executor_type: string;
  readonly external_reference: ExternalExecutionReference | null;
}

export type CancellationWaitTarget =
  | { readonly kind: "gate"; readonly workflow_id: string }
  | { readonly kind: "handoff"; readonly workflow_id: string };
