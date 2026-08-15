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

export interface CancellationExecutionTarget {
  readonly execution_id: ExecutionId;
  readonly executor_type: string;
  readonly external_reference: ExternalExecutionReference | null;
}
