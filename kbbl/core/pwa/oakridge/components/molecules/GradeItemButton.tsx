import { Button } from "../../../components/atoms/Button";
import type { ItemSelection } from "../../grading-types";

interface Props {
  selection: ItemSelection | null;
  onOpenItem?: (selection: ItemSelection) => void;
  /** "Grade" until the operator has answered every question the item lets them answer. */
  label?: string;
}

/** The one way into the item panel from a viewer. An item with no revision identity offers none. */
export function GradeItemButton({ selection, onOpenItem, label = "Grade" }: Props) {
  if (!selection || !onOpenItem) return null;
  return (
    <Button variant="secondary" size="xsmall" className="shrink-0 text-xs!" onClick={() => onOpenItem(selection)} data-testid="or-grade-item" data-item-path={selection.item_path}
      aria-label={`Open the finding at ${selection.item_path}`}>{label}</Button>
  );
}
