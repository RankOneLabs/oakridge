import type { OperatorInboxItem, OperatorUnitView } from "../operator-contracts";
import { operatorDraftIdentity, type OperatorDecisionSubmission } from "./operator-drafts";
import { selectDraftKey } from "./operator-selectors";

/** Per run, the inbox items that ask for the operator (a unit merely waiting does not). */
export const selectRunAttentionCounts = (items: readonly OperatorInboxItem[]): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.kind === "waiting") continue;
    counts.set(item.run_id, (counts.get(item.run_id) ?? 0) + 1);
  }
  return counts;
};

export const selectAttentionCount = (items: readonly OperatorInboxItem[] | undefined): number =>
  items?.filter((item) => item.kind === "decision").length ?? 0;

interface RecoveryCandidatesInput {
  readonly pending: readonly OperatorDecisionSubmission[];
  readonly units: readonly OperatorUnitView[];
  /** Identities already resubmitted from this view; an ingress replay answers each at most once. */
  readonly attempted: ReadonlySet<string>;
  readonly inFlight: ReadonlySet<string>;
}

/**
 * Pending submissions whose decision the units no longer offer: their form is
 * gone, so the run view resubmits them under the same request id, once.
 */
export const selectPendingDecisionsForRecovery = ({ pending, units, attempted, inFlight }: RecoveryCandidatesInput): readonly OperatorDecisionSubmission[] => {
  const offered = new Set(units.flatMap((unit) => unit.decisions.map((decision) => operatorDraftIdentity(selectDraftKey(unit, decision)))));
  const loaded = new Set(units.map((unit) => unit.unit_id));
  return pending.filter((submission) => {
    const identity = operatorDraftIdentity(submission);
    return loaded.has(submission.unit_id) && !offered.has(identity) && !inFlight.has(identity) && !attempted.has(identity);
  });
};
