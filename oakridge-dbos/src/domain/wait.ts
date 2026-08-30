/**
 * The record of gate and handoff waits.
 *
 * A wait is a point where the run cannot proceed until a specific answer
 * arrives. It is opened by the workflow that will `recv` the answer, closed
 * exactly once by that same workflow (single documented exception: cancellation
 * closing a provably dead owner's row on its behalf), and always about one
 * artifact revision. The row is the record; DBOS `recv` remains the mechanism.
 */
import type { ArtifactId, RunUnitId, StageInstanceId, UnitId, WaitId } from "./primitives";

export type WaitKind = "gate" | "handoff_downstream" | "handoff_external";

export type WaitClosesOn =
  | { readonly kind: "gate"; readonly gate_step: string; readonly actions: readonly string[] }
  | { readonly kind: "handoff_downstream"; readonly downstream_role: string }
  | { readonly kind: "handoff_external"; readonly external_wait_kind: string; readonly decision_artifact_id: ArtifactId };

export type WaitOutcome =
  | { readonly kind: "decided"; readonly action: string; readonly decision_artifact_id: ArtifactId | null; readonly feedback: string | null }
  | { readonly kind: "external_completed"; readonly correlation_id: string }
  | { readonly kind: "superseded"; readonly replacement_artifact_revision_id: ArtifactId }
  | { readonly kind: "withdrawn" } // actor/reason already live on the artifact row — not duplicated here
  | { readonly kind: "cancelled"; readonly reason: string | null };

export type GateWaitOutcome = Extract<WaitOutcome, { kind: "decided" | "superseded" | "withdrawn" | "cancelled" }>;
export type HandoffDownstreamWaitOutcome = Extract<WaitOutcome, { kind: "decided" | "superseded" | "withdrawn" | "cancelled" }>;
export type HandoffExternalWaitOutcome = Extract<WaitOutcome, { kind: "external_completed" | "superseded" | "withdrawn" | "cancelled" }>;

/**
 * A close names its kind and only that kind's outcomes: a gate never completes
 * externally, and an external wait is never decided — the pairing is the type,
 * so an invalid combination fails the compiler, not the state-view selector.
 */
export type CloseWaitRequest =
  | { readonly kind: "gate"; readonly outcome: GateWaitOutcome }
  | { readonly kind: "handoff_downstream"; readonly outcome: HandoffDownstreamWaitOutcome }
  | { readonly kind: "handoff_external"; readonly outcome: HandoffExternalWaitOutcome };

export interface Wait {
  readonly id: WaitId;
  readonly stage_instance_id: StageInstanceId;
  readonly unit_id: UnitId;
  readonly artifact_revision_id: ArtifactId;
  readonly closes_on: WaitClosesOn; // closes_on.kind duplicates the kind column; a CHECK keeps them equal
  readonly status: { readonly kind: "open" } | { readonly kind: "closed"; readonly outcome: WaitOutcome; readonly closed_at: string };
  /**
   * The v2 run-owned slot this wait guards, present exactly when a v2
   * publication opened the row — null for a legacy (stage/unit-scoped) wait.
   * Ownership and settlement follow these fields, not `stage_instance_id` /
   * `unit_id`, which stay purely descriptive for a v2 row.
   */
  readonly run_unit_id: RunUnitId | null;
  readonly output_name: string | null;
  /** The execution attempt this wait belongs to. Written at open from the
   *  opener's input, never reconstructed; both lookups take it as a predicate
   *  so a command can only reach the live attempt — a parked prior attempt's
   *  row misses the lookup and the caller's missing-state branch answers. */
  readonly execution_workflow_id: string;
  /** The DBOS workflow that answers commands for this wait — written at open,
   *  never reconstructed. These two are the only DBOS coupling in the row. */
  readonly command_workflow_id: string;
  readonly opened_at: string;
}

/** Everything a gate wait's opener records; nothing is resolved by lookup. */
export interface OpenGateWaitInput {
  readonly command_workflow_id: string;
  readonly stage_instance_id: StageInstanceId;
  readonly unit_id: UnitId;
  readonly artifact_revision_id: ArtifactId;
  readonly execution_workflow_id: string;
  readonly gate_step: string;
  readonly actions: readonly string[];
}

/** Everything a handoff's downstream wait records at open. */
export interface OpenHandoffDownstreamWaitInput {
  readonly command_workflow_id: string;
  readonly stage_instance_id: StageInstanceId;
  readonly unit_id: UnitId;
  readonly artifact_revision_id: ArtifactId;
  readonly execution_workflow_id: string;
  readonly downstream_role: string;
}

export type HandoffWaitKind = Extract<WaitKind, "handoff_downstream" | "handoff_external">;

export type HandoffWaitStatus = "awaiting_downstream" | "awaiting_external" | "revision_requested" | "released" | "superseded" | "withdrawn" | "cancelled";

/**
 * The ONE mapping from a handoff wait row to the status vocabulary its
 * consumers guard on — the cohort projection's row mapper is its one importer.
 *
 * `decided → revision_requested` is total, not a guess: a release-disposition
 * decision closes the downstream row and opens the external row in one
 * transaction, so a closed-decided downstream row with no external row can
 * only be the revision path.
 */
export const selectHandoffStatusFromWait = (
  kind: HandoffWaitKind,
  status: Wait["status"]["kind"],
  outcome: WaitOutcome["kind"] | null,
): HandoffWaitStatus => {
  if (status === "open") return kind === "handoff_external" ? "awaiting_external" : "awaiting_downstream";
  if (outcome === "superseded") return "superseded";
  if (outcome === "withdrawn") return "withdrawn";
  if (outcome === "cancelled") return "cancelled";
  if (outcome === "external_completed") return "released";
  if (outcome === "decided") return "revision_requested";
  throw new Error(`a closed handoff wait carries no outcome (kind '${kind}')`);
};
