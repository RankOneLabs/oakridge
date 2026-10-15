import type { OperatorInboxItem, OperatorUnitView } from "../operator-contracts";
import { operatorDraftIdentity, type OperatorDecisionSubmission } from "./operator-drafts";
import { selectDraftKey } from "./operator-selectors";

export interface RunAttention {
  readonly count: number;
  readonly decision_count: number;
  readonly by_unit: ReadonlyMap<string, number>;
}

/** One shape for a run's actionable attention from either inbox read. */
export const selectRunAttention = (items: readonly OperatorInboxItem[]): RunAttention => {
  const by_unit = new Map<string, number>();
  let count = 0;
  let decision_count = 0;
  for (const item of items) {
    if (item.kind === "waiting") continue;
    count += 1;
    if (item.kind === "decision") decision_count += 1;
    by_unit.set(item.unit_id, (by_unit.get(item.unit_id) ?? 0) + 1);
  }
  return { count, decision_count, by_unit };
};

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
