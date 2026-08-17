import type { ExecutionId, StageInstanceId, UnitId, WorkflowRunId } from "./primitives";

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
