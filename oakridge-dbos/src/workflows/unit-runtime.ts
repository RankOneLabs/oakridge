import type { UnitId } from "../domain/primitives";

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
