import type { OperatorDecisionDefinition, OperatorInboxItem, OperatorUnitView } from "../operator-contracts";
import { selectTargetRevisionId } from "./operator-selectors";

/** The decisions that ask for the operator: every one but the run's own cancel, which a live root always offers. */
export const selectUnitAsks = (unit: OperatorUnitView): readonly OperatorDecisionDefinition[] =>
  unit.decisions.filter((decision) => decision.submit.kind !== "cancel");

export const selectActionableUnits = (units: readonly OperatorUnitView[]): readonly OperatorUnitView[] =>
  units.filter((unit) => selectUnitAsks(unit).length > 0 && !unit.is_terminal);

/** The decisions made on one revision. */
export const selectArtifactDecisions = (unit: OperatorUnitView, revisionId: string): readonly OperatorDecisionDefinition[] =>
  unit.decisions.filter((decision) => selectTargetRevisionId(decision) === revisionId);

export type OperatorDecisionQueueEntry =
  | { readonly kind: "live"; readonly item: OperatorInboxItem }
  | { readonly kind: "settled"; readonly item: OperatorInboxItem };

const itemKey = (item: OperatorInboxItem): string => JSON.stringify([
  item.run_id, item.unit_id, item.kind,
  item.kind === "decision" ? item.key : item.kind === "waiting" ? item.reason : item.detail,
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
