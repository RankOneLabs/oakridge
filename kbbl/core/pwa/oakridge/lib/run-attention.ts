import type { OperatorInboxItem, OperatorUnitView } from "../operator-contracts";
import { operatorDraftIdentity, type OperatorCommandSubmission } from "./operator-drafts";
import { selectDraftKey } from "./operator-selectors";

export const selectRunAttentionCounts = (items: readonly OperatorInboxItem[]): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.kind === "wait") continue;
    counts.set(item.run_id, (counts.get(item.run_id) ?? 0) + 1);
  }
  return counts;
};

export const selectAttentionCount = (items: readonly OperatorInboxItem[] | undefined): number =>
  items?.filter((item) => item.kind === "decision").length ?? 0;

interface RecoveryCandidatesInput {
  readonly pending: readonly OperatorCommandSubmission[];
  readonly units: readonly OperatorUnitView[];
  readonly attemptedUnitVersions: ReadonlyMap<string, number>;
  readonly inFlight: ReadonlySet<string>;
}

export const selectPendingCommandsForRecovery = ({ pending, units, attemptedUnitVersions, inFlight }: RecoveryCandidatesInput): readonly OperatorCommandSubmission[] => {
  const current = new Set(units.flatMap((unit) => unit.decisions.flatMap((decision) => {
    const key = selectDraftKey(unit, decision);
    return key ? [operatorDraftIdentity(key)] : [];
  })));
  const unitVersions = new Map(units.map((unit) => [unit.unit_id, unit.cursor.unit_version]));
  return pending.filter((submission) => {
    const identity = operatorDraftIdentity(submission);
    const version = unitVersions.get(submission.unit_id);
    return version !== undefined && !current.has(identity) && !inFlight.has(identity)
      && attemptedUnitVersions.get(identity) !== version;
  });
};
