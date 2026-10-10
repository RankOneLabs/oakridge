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

interface RecoveryCandidatesInput {
  readonly pending: readonly OperatorCommandSubmission[];
  readonly scopes: readonly OperatorScopeView[];
  readonly attemptedScopeVersions: ReadonlyMap<string, number>;
  readonly inFlight: ReadonlySet<string>;
}

export const selectPendingCommandsForRecovery = ({ pending, scopes, attemptedScopeVersions, inFlight }: RecoveryCandidatesInput): readonly OperatorCommandSubmission[] => {
  const current = new Set(scopes.flatMap((scope) => scope.commands.flatMap((command) => {
    const key = selectDraftKey(scope, command);
    return key ? [operatorDraftIdentity(key)] : [];
  })));
  const scopeVersions = new Map(scopes.map((scope) => [scope.scope_id, scope.cursor.scope_version]));
  return pending.filter((submission) => {
    const identity = operatorDraftIdentity(submission);
    const version = scopeVersions.get(submission.scope_id);
    return version !== undefined && !current.has(identity) && !inFlight.has(identity)
      && attemptedScopeVersions.get(identity) !== version;
  });
};
