import { useState } from "react";
import { Button } from "../../../components/atoms/Button";

const fieldClass = "w-full min-h-24 resize-y rounded-md border border-[var(--accent-blue)] bg-[var(--bg-surface)] px-2.5 py-2 text-sm! text-[var(--text-primary)]";

interface Props {
  isPending: boolean;
  onAdd: (text: string) => void;
}

/** A button that opens an empty action field; adding hands the trimmed text up and closes it. */
export function AddNextAction({ isPending, onAdd }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [draft, setDraft] = useState("");

  if (!isOpen) {
    return <Button size="xsmall" className="self-start" disabled={isPending} onClick={() => setIsOpen(true)}>Add recommended next action</Button>;
  }

  const text = draft.trim();
  const close = () => { setDraft(""); setIsOpen(false); };
  return (
    <div className="flex flex-col gap-2">
      <textarea className={fieldClass} aria-label="New recommended next action" value={draft} disabled={isPending}
        onChange={(event) => setDraft(event.target.value)} autoFocus />
      <div className="flex gap-2">
        <Button variant="primary" size="xsmall" disabled={isPending || text.length === 0}
          onClick={() => { onAdd(text); close(); }}>Add action</Button>
        <Button size="xsmall" disabled={isPending} onClick={close}>Cancel</Button>
      </div>
    </div>
  );
}
