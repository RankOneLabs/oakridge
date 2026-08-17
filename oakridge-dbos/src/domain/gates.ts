import type { ArtifactId, Brand, ExecutionId, StageInstanceId, UnitId, WorkflowRunId } from "./primitives";
import { hasOwn, readOwn } from "./records";

export type GateDecisionAuditId = Brand<string, "GateDecisionAuditId">;
export type GateOutcome = "pass" | "fail" | "rerun";

/**
 * What a gate action does to the unit that is waiting on it, as a discriminant
 * rather than membership of a hardcoded name list.
 *
 * `release` lets the artifact through, `revise` sends the executor back to work
 * on it, `terminal` ends the unit. The same allowlist of release names was
 * written out at three sites, and anything absent from it fell through to
 * rejection — so a definition declaring a perfectly reasonable custom action
 * like `accept` would have failed its stage with `required_output_missing`
 * rather than releasing.
 */
export type GateDisposition = "release" | "revise" | "terminal";

export interface GateAction {
  readonly name: string;
  readonly disposition: GateDisposition;
}

/** The vocabulary the built-in gates ship with, and the only names a bare-string definition may use. */
export const BUILT_IN_GATE_DISPOSITIONS: Readonly<Record<string, GateDisposition>> = {
  pass: "release",
  approve: "release",
  confirm_merged: "release",
  closed_without_merge: "release",
  rerun: "revise",
  request_revision: "revise",
  fail: "terminal",
};

/**
 * The disposition of a decision against the actions its gate step declared.
 * An action the step never offered is `terminal`: the operator surface refuses
 * it before it reaches here, so arriving anyway means the step moved under a
 * decision already in flight, and ending the unit is the safe reading.
 */
export const selectGateDisposition = (action: string, declared: readonly GateAction[]): GateDisposition =>
  declared.find((candidate) => candidate.name === action)?.disposition ?? "terminal";

/**
 * Whether a name is genuinely in the vocabulary. A plain index answers truthily
 * for `toString` and `constructor`, so an action named after an inherited
 * property passed validation and then resolved to a `Function` wearing a
 * `GateDisposition` type.
 */
export const isBuiltInGateAction = (action: string): boolean => hasOwn(BUILT_IN_GATE_DISPOSITIONS, action);

/** For surfaces that hold a decision but not the step it was made against. */
export const selectBuiltInGateDisposition = (action: string): GateDisposition =>
  readOwn(BUILT_IN_GATE_DISPOSITIONS, action) ?? "terminal";
export interface GateDecision { readonly outcome: GateOutcome; readonly comment: string | null; readonly feedback: string | null }
export interface GateDecisionAudit {
  readonly id: GateDecisionAuditId;
  readonly run_id: WorkflowRunId;
  readonly stage_instance_id: StageInstanceId;
  readonly execution_id: ExecutionId;
  readonly unit_id: UnitId;
  readonly artifact_chain_id: ArtifactId;
  readonly artifact_revision_id: ArtifactId;
  readonly gate_step: string;
  readonly action: string;
  readonly operator_comment: string | null;
  readonly feedback: string | null;
  readonly idempotency_key: string;
  readonly created_at: string;
  readonly applied_at: string | null;
}
