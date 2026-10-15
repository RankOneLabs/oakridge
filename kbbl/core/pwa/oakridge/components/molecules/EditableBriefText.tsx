import { useState } from "react";
import { Button } from "../../../components/atoms/Button";
import type { ViewerProps } from "../../artifactRegistry";

const fieldClass = "w-full rounded-md border border-[var(--accent-blue)] bg-[var(--bg-surface)] px-2.5 py-2 text-sm! text-[var(--text-primary)]";

interface Props {
  anchor: string;
  value: string;
  edit: NonNullable<ViewerProps["edit"]>;
  isMultiline?: boolean;
}

/** One brief atom in edit mode: shows its value, swaps to a field on click, submits on blur. */
export function EditableBriefText({ anchor, value, edit, isMultiline = false }: Props) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  if (!isEditing) {
    return (
      <Button
        variant="secondary"
        aria-label={`Edit ${anchor.slice(1).replaceAll("_", " ")}`}
        // The secondary variant centres a single line; an atom is wrapped, left-aligned prose.
        className="review-shell__tap-target w-full items-start! justify-start! whitespace-pre-wrap px-2.5! py-2! text-left text-sm!"
        onClick={() => { setDraft(value); setIsEditing(true); }}
      >
        {value}
      </Button>
    );
  }

  const commit = () => {
    if (draft !== value) edit.onEdit(anchor, value, draft);
    setIsEditing(false);
  };
  return isMultiline ? (
    <textarea className={`${fieldClass} min-h-32 resize-y`} value={draft} disabled={edit.isPending} onChange={(event) => setDraft(event.target.value)} onBlur={commit} autoFocus />
  ) : (
    <input className={fieldClass} value={draft} disabled={edit.isPending} onChange={(event) => setDraft(event.target.value)} onBlur={commit} autoFocus />
  );
}
