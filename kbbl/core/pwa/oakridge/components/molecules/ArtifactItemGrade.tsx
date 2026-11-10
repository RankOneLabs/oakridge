import type { ViewerProps } from "../../artifactRegistry";
import { selectItemSelection } from "../../lib/grading";
import { GradeItemButton } from "./GradeItemButton";

interface Props extends Pick<ViewerProps, "source" | "itemGrading" | "onOpenItem"> { itemPath: string }

/** One task, contribution or finding, addressed at its original position in the artifact. */
export function ArtifactItemGrade({ source, itemPath, itemGrading, onOpenItem }: Props) {
  const selection = selectItemSelection(source, itemPath);
  return selection && itemGrading ? itemGrading.renderItemAction(selection)
    : <GradeItemButton selection={selection} onOpenItem={onOpenItem} />;
}
