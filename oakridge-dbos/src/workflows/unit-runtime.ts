import type { ArtifactRevision, ExecutionContractState } from "../domain/artifacts";
import type { ExecutorTerminalObservation } from "../domain/execution";
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

/** What a finished unit turned out to be, decided from the record alone. */
export type UnitSettlement =
  | { readonly kind: "released"; readonly artifacts: readonly ArtifactRevision[] }
  | { readonly kind: "failed"; readonly code: string; readonly detail: string };

/** Recorded facts that explain a failure. Never inputs to whether there is one. */
export interface UnitSettlementEvidence {
  /** The error the execution workflow threw, if it threw. */
  readonly execution_error: string | null;
  /** What the executor's observer last recorded about the session. */
  readonly terminal_observation: ExecutorTerminalObservation | null;
}

/**
 * Whether a unit whose execution has returned is done.
 *
 * Decided from the contract and nothing else: a unit is done when every output
 * it owes has been released, and the record of what was released is the
 * artifact table. The session that produced them is not consulted. It may have
 * exited non-zero after emitting, been closed by our own fence, or been
 * declared silent by the watchdog while its output sat in a gate for an hour
 * waiting on a human — each of those is recorded on the projection, and none
 * of them changes what was released. Reading them here is what parked
 * accepted units for rerun in runs 4f4a159a and 9cd69a4a, one of them a merged
 * pull request, with nothing that depended on them able to launch.
 *
 * The evidence only names why an unsatisfied contract went unsatisfied, so the
 * operator holding the rerun can tell an agent that crashed from one that went
 * quiet from one that simply never emitted.
 */
export const selectUnitSettlement = (unit_id: UnitId, contract: ExecutionContractState, evidence: UnitSettlementEvidence): UnitSettlement => {
  if (contract.kind === "satisfied") return { kind: "released", artifacts: contract.artifacts };
  if (evidence.execution_error !== null) return { kind: "failed", code: "execution_workflow_error", detail: evidence.execution_error };
  if (evidence.terminal_observation?.kind === "failed") return { kind: "failed", code: evidence.terminal_observation.code, detail: evidence.terminal_observation.detail };
  return { kind: "failed", code: "required_output_missing", detail: `unit '${unit_id}' is missing: ${contract.missing_outputs.join(", ")}` };
};
