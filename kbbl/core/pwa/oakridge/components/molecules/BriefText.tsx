import type { ViewerProps } from "../../artifactRegistry";
import { EditableBriefText } from "./EditableBriefText";
import { ExpandableText } from "./ExpandableText";

export type Editor = NonNullable<ViewerProps["edit"]> | null;

interface BriefTextProps {
  anchor: string;
  value: string;
  editor: Editor;
  className: string;
  isProse?: boolean;
  lineCount?: 3 | 6;
}

/** An atom read as text, or as an edit trigger while the brief is in edit mode. */
export function BriefText({ anchor, value, editor, className, isProse = false, lineCount = 3 }: BriefTextProps) {
  if (editor) return <EditableBriefText anchor={anchor} value={value} edit={editor} isMultiline={isProse} />;
  return isProse ? <ExpandableText text={value} className={className} lineCount={lineCount} /> : <span className={className}>{value}</span>;
}
