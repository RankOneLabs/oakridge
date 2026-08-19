import type { ExecutionId, StageInstanceId, UnitId, WorkflowRunId } from "./primitives";
import { selectWorkflowRecovery } from "./workflow-recovery";

/**
 * A live execution's claim on the agent session running it.
 *
 * A gate exists so a person can review at their own pace, but the artifact it
 * guards is released by the execution workflow — and that workflow stops
 * waiting the moment its session reports a non-success terminal. Closing a
 * session while its stage is still running therefore abandons the unit
 * silently: the artifact stays unreleased, the gate stays approvable, and the
 * eventual approval is recorded against a workflow that has already returned.
 *
 * kbbl cannot know any of this on its own — liveness belongs to Oakridge — so
 * it asks before honouring a close.
 */
export interface SessionHold {
  readonly session_id: string;
  readonly execution_id: ExecutionId;
  readonly execution_workflow_id: string;
  readonly run_id: WorkflowRunId;
  readonly stage_instance_id: StageInstanceId;
  readonly stage_key: string;
  readonly unit_id: UnitId;
}

/**
 * What a PENDING execution workflow's claim on a session is actually worth.
 *
 * PENDING is not the same as alive — see `selectWorkflowRecovery`, which is the
 * general form of this question. Read as a hold, an unrecoverable row is a
 * claim nobody will ever release: the session cannot be closed, this attempt,
 * or any attempt after it. That is worse than the accident the guard exists to
 * prevent, because abandoning a unit whose workflow is already unreachable
 * costs nothing — there is no longer a workflow waiting to be stranded.
 */
export type SessionHoldClaim =
  /** A workflow this executor can still recover. Honour the hold. */
  | { readonly kind: "held"; readonly hold: SessionHold }
  /**
   * A workflow stranded at a version this executor does not serve. Nothing
   * will resume it, so it holds nothing.
   */
  | {
      readonly kind: "abandoned";
      readonly hold: SessionHold;
      readonly holder_application_version: string;
    };

/** Whether a found hold is one this executor can still make good on. */
export const selectSessionHoldClaim = (
  hold: SessionHold,
  holder_application_version: string | null,
  executor_application_version: string,
): SessionHoldClaim => {
  const recovery = selectWorkflowRecovery(holder_application_version, executor_application_version);
  return recovery.kind === "recoverable"
    ? { kind: "held", hold }
    : { kind: "abandoned", hold, holder_application_version: recovery.holder_application_version };
};
