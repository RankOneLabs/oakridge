import type { ExecutionId, StageInstanceId, UnitId, WorkflowRunId } from "./primitives";
import type { ExternalExecutionReference } from "./execution";
import { selectWorkflowRecovery } from "./workflow-recovery";

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

/** A wait stranded at a version this executor cannot recover, and that version. */
export interface OrphanedCancellationWait {
  readonly wait: CancellationWaitTarget;
  readonly holder_application_version: string;
}

/**
 * Which waits containment can talk to, and which it has to terminalize itself.
 *
 * Withdrawing a wait is a conversation — send the command, then wait for the
 * workflow to acknowledge by terminalizing. A wait this executor cannot recover
 * is not on the other end of it: nothing will resume the workflow to read the
 * message, so awaiting its result blocks forever and takes the whole
 * cancellation down. Cancelling is the documented way out of a stuck run, so
 * the runs that most need it must not be the ones it hangs on.
 */
export interface CancellationWaitSplit {
  readonly answerable: readonly CancellationWaitTarget[];
  readonly orphaned: readonly OrphanedCancellationWait[];
}

export const selectCancellationWaitSplit = (
  waits: readonly CancellationWaitTarget[],
  executor_application_version: string,
): CancellationWaitSplit => {
  const answerable: CancellationWaitTarget[] = [];
  const orphaned: OrphanedCancellationWait[] = [];
  for (const wait of waits) {
    const recovery = selectWorkflowRecovery(wait.application_version, executor_application_version);
    if (recovery.kind === "recoverable") answerable.push(wait);
    else orphaned.push({ wait, holder_application_version: recovery.holder_application_version });
  }
  return { answerable, orphaned };
};
