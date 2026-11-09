import { Button } from "../../../components/atoms/Button";
import type { ItemSelection } from "../../grading-types";

/** The one way into the item panel from a viewer. An item with no revision identity offers none. */
export function GradeItemButton({ selection, onOpenItem }: { selection: ItemSelection | null; onOpenItem?: (selection: ItemSelection) => void }) {
  if (!selection || !onOpenItem) return null;
  return (
    <Button variant="secondary" size="xsmall" className="shrink-0 text-xs!" onClick={() => onOpenItem(selection)} data-testid="or-grade-item" data-item-path={selection.item_path}
      aria-label={`Open the finding at ${selection.item_path}`}>Grade</Button>
  );
}
