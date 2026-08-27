import type { ArtifactId, ExecutionId, StageCoordinatorWorkflowId, UnitId } from "./primitives";

/**
 * The workflow-ID grammar, in one place.
 *
 * Every ID is derived from its parent by concatenation, and `DBOS.send` to an
 * ID nothing listens on still returns success — so a producer and a consumer
 * that disagree by one separator produce a command that is silently never
 * delivered, with a 202 to say it went fine. These were composed ad hoc at a
 * dozen call sites, and twice inside raw SQL where no type could see them.
 */

/** `<root>:stage:<stage_key>` */
export const stageCoordinatorWorkflowId = (root_workflow_id: string, stage_key: string): StageCoordinatorWorkflowId =>
  `${root_workflow_id}:stage:${stage_key}` as StageCoordinatorWorkflowId;

/** `<coordinator>:unit:<unit_id>` */
export const UNIT_INFIX = ":unit:";
export const unitExecutionWorkflowId = (coordinator_workflow_id: string, unit_id: UnitId): string =>
  `${coordinator_workflow_id}${UNIT_INFIX}${unit_id}`;

/**
 * `<coordinator>:unit:<unit_id>:revision:<artifact_id>` — the replacement
 * execution for a unit put back to work on a revised input.
 *
 * A unit's ordinary execution ID carries no revision, so restarting one under
 * it is deduplicated by DBOS onto the run that already finished — the unit
 * would look relaunched and never move. Keyed by the revising artifact rather
 * than a counter, so the same revision always resolves to the same ID and a
 * redelivered `input_released` cannot launch a second agent on the same work.
 */
export const unitRevisionExecutionWorkflowId = (coordinator_workflow_id: string, unit_id: UnitId, artifact_id: ArtifactId): string =>
  `${unitExecutionWorkflowId(coordinator_workflow_id, unit_id)}:revision:${artifact_id}`;

/** `<subject>:relay` — a relay watches its subject and reports to its starter. */
export const relayWorkflowId = (subject_workflow_id: string): string => `${subject_workflow_id}:relay`;

/** `<execution>:terminal` — also matched in SQL, hence the exported suffix. */
export const TERMINAL_OBSERVER_SUFFIX = ":terminal";
export const terminalObserverWorkflowId = (execution_workflow_id: string): string =>
  `${execution_workflow_id}${TERMINAL_OBSERVER_SUFFIX}`;

/** `<execution>:gate:<artifact_id>` */
export const gateRelayWorkflowId = (execution_workflow_id: string, artifact_id: ArtifactId): string =>
  `${execution_workflow_id}:gate:${artifact_id}`;

/** `<execution>:gate:<artifact_id>:wait:<gate_step>` — the workflow an operator decision reaches. */
export const gateWaitWorkflowId = (execution_workflow_id: string, artifact_id: ArtifactId, gate_step: string): string =>
  `${gateRelayWorkflowId(execution_workflow_id, artifact_id)}:wait:${gate_step}`;

/** The wait as named from inside its own relay, which already owns the prefix. */
export const gateWaitWorkflowIdFromRelay = (gate_relay_workflow_id: string, gate_step: string): string =>
  `${gate_relay_workflow_id}:wait:${gate_step}`;

/** `<execution>:handoff:<artifact_id>` — also matched in SQL, hence the exported infix. */
export const HANDOFF_INFIX = ":handoff:";
export const handoffWorkflowId = (execution_workflow_id: string, artifact_id: ArtifactId): string =>
  `${execution_workflow_id}${HANDOFF_INFIX}${artifact_id}`;

/** `<owner>:fence:<execution_id>` */
export const executorFenceWorkflowId = (owner_workflow_id: string, execution_id: ExecutionId): string =>
  `${owner_workflow_id}:fence:${execution_id}`;
