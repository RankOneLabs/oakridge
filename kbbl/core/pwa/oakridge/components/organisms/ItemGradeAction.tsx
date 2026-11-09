import { Button } from "../../../components/atoms/Button";
import type { ItemSelection } from "../../grading-types";
import { useItemGlance } from "../../hooks/useItemGlance";
import { useReviewer } from "../../hooks/useReviewer";
import { gradeActionLabel, itemSelectionKey, selectAutomaticGlances, selectOwnGradeProgress } from "../../lib/grading";
import { useGradingVisibility } from "../../state/gradingVisibility";
import { AutomaticGradeIcons } from "../molecules/AutomaticGradeIcons";
import { GradeItemButton } from "../molecules/GradeItemButton";

interface Props {
  runId: string;
  selection: ItemSelection;
  onOpenItem: (selection: ItemSelection) => void;
}

/**
 * A finding row's grading control on an artifact: the operator's own progress on its Grade button,
 * and, only while this item is revealed, a glyph per automatic answer. The detail stays in the item panel.
 */
export function ItemGradeAction({ runId, selection, onOpenItem }: Props) {
  const key = itemSelectionKey(selection);
  const isRevealed = useGradingVisibility((state) => state.revealed_item_keys.has(key));
  const reveal = useGradingVisibility((state) => state.revealItem);
  const hide = useGradingVisibility((state) => state.hideItem);
  const glance = useItemGlance(runId, selection);
  const reviewer = useReviewer();
  const progress = glance.data && reviewer.data ? selectOwnGradeProgress(glance.data, reviewer.data.reviewer_id) : null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5" data-testid="or-item-grade-action" data-revealed={isRevealed}>
      {isRevealed && glance.data && <AutomaticGradeIcons glances={selectAutomaticGlances(glance.data)} />}
      {glance.data && (
        <Button variant="secondary" size="xsmall" className="text-xs!" data-testid="or-item-automatic-toggle" aria-pressed={isRevealed}
          aria-label={isRevealed ? `Hide answers for the finding at ${selection.item_path}` : `Show answers for the finding at ${selection.item_path}`}
          onClick={() => (isRevealed ? hide(key) : reveal(key))}>{isRevealed ? "Hide" : "Show"}</Button>
      )}
      <GradeItemButton selection={selection} onOpenItem={onOpenItem} label={gradeActionLabel(progress)} />
    </span>
  );
}
