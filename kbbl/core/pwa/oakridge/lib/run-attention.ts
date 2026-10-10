import type { OperatorInboxItem, OperatorScopeView } from "../operator-contracts";
import { operatorDraftIdentity, type OperatorCommandSubmission } from "./operator-drafts";
import { selectDraftKey } from "./operator-selectors";

export const selectRunAttentionCounts = (items: readonly OperatorInboxItem[]): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.run_id, (counts.get(item.run_id) ?? 0) + 1);
  return counts;
};

export const selectAttentionCount = (items: readonly OperatorInboxItem[] | undefined): number =>
  items?.filter((item) => item.kind === "command").length ?? 0;

export const selectPendingCommandsForRecovery = (
  pending: readonly OperatorCommandSubmission[], scopes: readonly OperatorScopeView[],
): readonly OperatorCommandSubmission[] => {
  const current = new Set(scopes.flatMap((scope) => scope.commands.flatMap((command) => {
    const key = selectDraftKey(scope, command);
    return key ? [operatorDraftIdentity(key)] : [];
  })));
  return pending.filter((submission) => !current.has(operatorDraftIdentity(submission)));
};
