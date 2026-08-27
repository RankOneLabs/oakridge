import type { UnitId } from "../domain/primitives";
import type { HandoffWorkflowState } from "../domain/wait";

/**
 * Where one of a stage's units stands inside the coordinator that owns it.
 *
 * A unit with no entry has never been launched. Everything else carries the
 * execution workflow the coordinator is currently watching, because a unit can
 * outlive several of them: a rerun replaces a failed execution with a fork under
 * a new workflow ID, and the old one may still have a completion signal in
 * flight. Keying on the live execution is what lets that late signal be
 * recognised as stale rather than settling the unit a second time.
 */
export type UnitRuntime =
  | { readonly kind: "running"; readonly execution_workflow_id: string }
  | { readonly kind: "awaiting_rerun"; readonly execution_workflow_id: string }
  | { readonly kind: "released" };

export type UnitRuntimeState = ReadonlyMap<UnitId, UnitRuntime>;

/** Every unit the stage has started, whatever became of it. */
export const selectLaunchedUnits = (runtime: UnitRuntimeState): ReadonlySet<UnitId> => new Set(runtime.keys());

export const selectReleasedUnits = (runtime: UnitRuntimeState): ReadonlySet<UnitId> =>
  new Set([...runtime].filter(([, state]) => state.kind === "released").map(([unitId]) => unitId));

/** Units holding a slot in the parallelism window — parked ones do not. */
export const selectRunningUnitCount = (runtime: UnitRuntimeState): number =>
  [...runtime.values()].filter((state) => state.kind === "running").length;

/** Whether a completion signal names the execution this unit is still on. */
export const isLiveExecution = (runtime: UnitRuntimeState, unit_id: UnitId, execution_workflow_id: string): boolean => {
  const state = runtime.get(unit_id);
  return state?.kind === "running" && state.execution_workflow_id === execution_workflow_id;
};

/** Whether a rerun command names the exact failed execution this unit is parked on. */
export const isAwaitingReplacementOf = (runtime: UnitRuntimeState, unit_id: UnitId, failed_execution_workflow_id: string): boolean => {
  const state = runtime.get(unit_id);
  return state?.kind === "awaiting_rerun" && state.execution_workflow_id === failed_execution_workflow_id;
};

/** A stage is done when no further units can arrive and every one it has is released. */
export const isStageDrained = (runtime: UnitRuntimeState, unit_count: number, is_closed: boolean): boolean =>
  is_closed && selectReleasedUnits(runtime).size === unit_count;

/**
 * How a revised input reaches the unit that consumes it.
 *
 * A running unit has an agent to ask, so it is told. One that already released
 * has none — and its own output was derived from what the revision replaces,
 * so it is stale and the producer is left holding a wait only this unit can
 * close. That unit is relaunched rather than skipped.
 *
 * A unit parked for rerun is deliberately left alone: an operator is holding
 * the failure, and relaunching underneath them would discard it.
 */
export type RevisionDelivery =
  | { readonly kind: "notify"; readonly unit_id: UnitId; readonly execution_workflow_id: string }
  | { readonly kind: "relaunch"; readonly unit_id: UnitId }
  | { readonly kind: "none" };

export const selectRevisionDelivery = (runtime: UnitRuntimeState, unit_id: UnitId | null): RevisionDelivery => {
  if (unit_id === null) return { kind: "none" };
  const state = runtime.get(unit_id);
  if (state?.kind === "running") return { kind: "notify", unit_id, execution_workflow_id: state.execution_workflow_id };
  if (state?.kind === "released") return { kind: "relaunch", unit_id };
  return { kind: "none" };
};

/**
 * Whether a revision handed to a running consumer is still waiting on that
 * consumer now that it has returned.
 *
 * A message to an execution that was already finishing is never read, and the
 * result it returns says nothing about it. The record of whether anyone acted
 * is the revision's handoff: decided or beyond, the consumer — or an operator —
 * got to it; still awaiting its downstream, nobody did. No handoff at all is a
 * revision of a plainly released input, or one whose wait is not written yet;
 * either way the consumer owes it a look.
 */
export const isRevisionUndecided = (state: HandoffWorkflowState | null): boolean =>
  state === null || state.status === "awaiting_downstream";
