import type { OperatorDecisionDefinition, OperatorDefinitionSummary, OperatorRunUnitSummary, OperatorUnitView } from "../operator-contracts";
import type { OperatorDraftKey } from "./operator-drafts";

/** The revision a decision decides: a review's target, or none for a retry or cancel. */
export const selectTargetRevisionId = (decision: OperatorDecisionDefinition): string | null =>
  decision.submit.kind === "review" ? decision.submit.target_revision_id : null;

export const selectDraftKey = (unit: OperatorUnitView, decision: OperatorDecisionDefinition): OperatorDraftKey =>
  ({ run_id: unit.run_id, unit_id: unit.unit_id, decision_key: decision.key, target_revision_id: selectTargetRevisionId(decision) });

export interface RootUnitInput { readonly units: readonly Pick<OperatorRunUnitSummary, "unit_id" | "unit_key">[]; readonly root_key: string }

/**
 * A run lists its units by id, so position says nothing; the pinned
 * definition's `root` key names the root unit. Null when the run has no unit
 * under that key, rather than a guess at another one.
 */
export function selectRootUnitId({ units, root_key }: RootUnitInput): string | null {
  return units.find((unit) => unit.unit_key === root_key)?.unit_id ?? null;
}

export interface LaunchDigestInput {
  /** The digest of a launch awaiting confirmation, which is not the operator's to change. */
  readonly pending_digest: string | undefined;
  readonly chosen_digest: string;
  readonly definitions: readonly OperatorDefinitionSummary[] | undefined;
}

/**
 * Definitions have no order the operator can rely on, so only an explicit choice
 * or an only candidate selects one; with several to pick from, none is selected.
 */
export function selectLaunchDigest({ pending_digest, chosen_digest, definitions }: LaunchDigestInput): string {
  if (pending_digest) return pending_digest;
  if (chosen_digest) return chosen_digest;
  return definitions?.length === 1 ? definitions[0]?.digest ?? "" : "";
}
