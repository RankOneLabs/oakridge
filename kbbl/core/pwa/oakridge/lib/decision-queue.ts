import type { OperatorCommandDefinition, OperatorInboxItem, OperatorScopeView } from "../operator-contracts";
import { selectCommandTargets } from "./operator-selectors";

export const selectActionableScopes = (scopes: readonly OperatorScopeView[]): readonly OperatorScopeView[] =>
  scopes.filter((scope) => scope.commands.length > 0 && !scope.is_terminal);

export const selectArtifactCommands = (scope: OperatorScopeView, revisionId: string): readonly OperatorCommandDefinition[] =>
  scope.commands.filter((command) => selectCommandTargets(scope, command)?.some((target) => target.identity === revisionId));

export type OperatorDecisionQueueEntry =
  | { readonly kind: "live"; readonly item: OperatorInboxItem }
  | { readonly kind: "settled"; readonly item: OperatorInboxItem };

const itemKey = (item: OperatorInboxItem): string => JSON.stringify([
  item.run_id, item.scope_id, item.kind,
  item.kind === "command" ? item.key : item.kind === "wait" ? item.reason : item.detail,
]);

/** Preserve row position across refreshes so disappearing work cannot move another action beneath the pointer. */
export function selectStableOperatorDecisionQueue(
  previous: readonly OperatorDecisionQueueEntry[], items: readonly OperatorInboxItem[],
): readonly OperatorDecisionQueueEntry[] {
  const incoming = new Map(items.map((item) => [itemKey(item), item]));
  const known = new Set(previous.map((entry) => itemKey(entry.item)));
  return [
    ...previous.map((entry): OperatorDecisionQueueEntry => {
      const current = incoming.get(itemKey(entry.item));
      return current ? { kind: "live", item: current } : { kind: "settled", item: entry.item };
    }),
    ...items.filter((item) => !known.has(itemKey(item))).map((item): OperatorDecisionQueueEntry => ({ kind: "live", item })),
  ];
}
