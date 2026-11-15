import { useState } from "react";
import { Button } from "../../../components/atoms/Button";
import type { ViewerProps } from "../../artifactRegistry";
type TaskEditControlsSlotProps = Parameters<NonNullable<ViewerProps["renderTaskEditControls"]>>[0];
interface TaskEditControlsProps extends TaskEditControlsSlotProps {}
export function TaskEditControls({ task, anchor, edit: editor }: TaskEditControlsProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const add = () => {
    const id = draft.trim();
    if (id) editor.onEdit(`${anchor}/requirement_ids`, task.requirement_ids, [...task.requirement_ids, id]);
    setDraft("");
    setIsAdding(false);
  };

  return <>
      {isAdding
        ? <span className="inline-flex items-center gap-1">
          <input aria-label="New requirement ID" className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-1 text-sm" value={draft}
            disabled={editor.isPending} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") add(); }} />
          <Button variant="secondary" size="xsmall" disabled={editor.isPending || !draft.trim()} onClick={add}>Save link</Button>
          <Button variant="secondary" size="xsmall" onClick={() => setIsAdding(false)}>Cancel</Button>
        </span>
        : <Button variant="secondary" size="xsmall" disabled={editor.isPending} onClick={() => setIsAdding(true)}>Add link</Button>}
  </>;
}
