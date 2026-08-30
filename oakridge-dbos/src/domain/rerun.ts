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

/**
 * A wait that containment has to stop.
 *
 * `application_version` is the one the wait workflow was started under, carried
 * because containment withdraws a wait by talking to it — and a workflow this
 * executor cannot recover will never listen. Without it, containment cannot
 * tell a wait that is about to answer from one that never will.
 */
export type CancellationWaitTarget =
  | { readonly kind: "gate"; readonly workflow_id: string; readonly application_version: string | null }
  | { readonly kind: "handoff"; readonly workflow_id: string; readonly application_version: string | null };
