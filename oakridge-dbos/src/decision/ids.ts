/**
 * The ids `derive` mints — spec §13, moved verbatim from
 * `runtime/run-materialization.ts`. Determinism here is what makes replay
 * and duplicate-ask safety free: never introduce a random id anywhere in
 * the decision path.
 */
import { createHash } from "node:crypto";

import type { ArtifactId, AttemptId, CohortId, InputFingerprint, RunTransitionId, RunUnitId, SessionId, StageInstanceId, UnitId, WaitId, WorkflowRunId, WorkOrderId } from "../domain/primitives";
import type { TransitionOwner } from "../domain/run-record";
import type { StageKey } from "../domain/workflow";

const stableUuid = (identity: string): string => {
  const hex = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
};

export const stageInstanceIdFor = (run_id: WorkflowRunId, stage_key: StageKey): StageInstanceId =>
  stableUuid(`${run_id}:stage:${stage_key}`) as StageInstanceId;

export const runUnitIdFor = (run_id: WorkflowRunId, stage_key: StageKey, unit_id: UnitId): RunUnitId =>
  stableUuid(`${run_id}:${stage_key}:unit:${unit_id}`) as RunUnitId;

/** `identity` is `"initial"` or `"revision:<fingerprint>"`. */
export const workOrderIdFor = (run_id: WorkflowRunId, stage_key: StageKey, unit_id: UnitId, identity: string): WorkOrderId =>
  stableUuid(`${run_id}:${stage_key}:${unit_id}:${identity}`) as WorkOrderId;

export const workOrderWorkflowId = (work_order_id: WorkOrderId): string => `v2-work:${work_order_id}`;

export const fingerprintOf = (value: unknown): InputFingerprint => createHash("sha256").update(JSON.stringify(value)).digest("hex") as InputFingerprint;

const ownerIdentity = (owner: TransitionOwner): string => `${owner.kind}:${owner.id}`;

export const runMachineWorkflowId = (run_id: WorkflowRunId): string => `v15-run:${run_id}`;
export const stageMachineWorkflowId = (stage_instance_id: StageInstanceId): string => `v15-stage:${stage_instance_id}`;

export const transitionIdFor = (owner: TransitionOwner, resulting_version: number): RunTransitionId =>
  stableUuid(`v15-transition:${ownerIdentity(owner)}:${resulting_version}`) as RunTransitionId;

/** The one durable address for the effect recorded on a transition row. */
export const transitionEffectWorkflowId = (owner: TransitionOwner, resulting_version: number): string =>
  `v15-effect:${ownerIdentity(owner)}:${resulting_version}`;

/**
 * An attempt and the session that runs it, both named by the transition that
 * launched them and the attempt number it selected. Deterministic so a replayed
 * dispatch of the same launch transition finds the rows it already made.
 */
export const attemptIdFor = (cohort_id: CohortId, attempt_number: number,
  worker: import("../domain/dev-flow-v15").V15WorkerKey = "build"): AttemptId =>
  stableUuid(`v15-attempt:${cohort_id}:${worker === "build" ? "" : `${worker}:`}${attempt_number}`) as AttemptId;

export const sessionIdFor = (attempt_id: AttemptId): SessionId =>
  stableUuid(`v15-session:${attempt_id}`) as SessionId;

export const attemptWorkflowId = (attempt_id: AttemptId): string => `v15-attempt:${attempt_id}`;

/**
 * The wait a parked output slot opens, named by the revision it holds.
 *
 * One revision parks one slot, so the revision is the wait's natural key: a
 * retried publication of the same body under the same attempt replays onto the
 * same wait rather than opening a second one for the operator to decide twice.
 */
export const waitGateIdFor = (artifact_id: ArtifactId): WaitId =>
  stableUuid(`v15-wait:${artifact_id}`) as WaitId;

export const waitGateCommandWorkflowId = (artifact_id: ArtifactId): string => `v15-wait:${artifact_id}`;

export const stageGateIdFor = (cohort_id: CohortId, gate: string, round: number): WaitId =>
  stableUuid(`v15-gate:${cohort_id}:${gate}:${round}`) as WaitId;

export const stageGateCommandWorkflowId = (cohort_id: CohortId, gate: string, round: number): string =>
  `v15-gate:${cohort_id}:${gate}:${round}`;
