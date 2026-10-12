import type { OperatorAvailableDecision, OperatorDefinitionSummary, OperatorRunView, OperatorUnitView } from "../operator-contracts";
import type { OperatorDraftKey } from "./operator-drafts";

/**
 * A decision targets the newest revision of the artifact its review is `of`.
 * The identity comes from the observed projection, never a later fetch, so an
 * operator decision cannot silently retarget a revision published since.
 */
export function selectTargetRevisionId(unit: OperatorUnitView, decision: OperatorAvailableDecision): string | null {
  const matching = unit.revisions.filter((revision) => revision.artifact === decision.artifact);
  return matching.length === 0 ? null : matching[matching.length - 1]!.id;
}

export function selectDraftKey(unit: OperatorUnitView, decision: OperatorAvailableDecision): OperatorDraftKey | null {
  const target_revision_id = selectTargetRevisionId(unit, decision);
  return target_revision_id === null ? null : { run_id: unit.run_id, unit_id: unit.unit_id,
    review: decision.review, decision: decision.decision,
    owner_version: unit.cursor.unit_version, target_revision_id };
}

export interface RootUnitInput { readonly units: readonly Pick<OperatorRunView["units"][number], "unit_id" | "unit_key">[]; readonly root_key: string }

/**
 * The server lists a run's units by random id, so position says nothing; the
 * pinned definition's root key names the root unit. Null when the run has no
 * unit under that key, rather than a guess at another one.
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
