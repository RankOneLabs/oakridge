import { Button } from "../../../components/atoms/Button";
import type { ObservationItemAddress } from "../../grading-contracts/grading/item-reads";
import { itemSelectionKey } from "../../lib/grading";
import { useGradingVisibility } from "../../state/gradingVisibility";

/** One control over every finding an artifact shows: reveal or hide their answers together. A UI preference only. */
export function ShowAutomaticGrades({ selections }: { selections: readonly ObservationItemAddress[] }) {
  const keys = selections.map(itemSelectionKey);
  const isAllRevealed = useGradingVisibility((state) => keys.length > 0 && keys.every((key) => state.revealed_item_keys.has(key)));
  const revealItems = useGradingVisibility((state) => state.revealItems);
  const hideItems = useGradingVisibility((state) => state.hideItems);
  if (keys.length === 0) return null;
  return (
    <Button variant="secondary" size="xsmall" className="self-start text-xs!" data-testid="or-show-automatic-grades" aria-pressed={isAllRevealed}
      onClick={() => (isAllRevealed ? hideItems(keys) : revealItems(keys))}>{isAllRevealed ? "Hide automatic grades" : "Show automatic grades"}</Button>
  );
}
