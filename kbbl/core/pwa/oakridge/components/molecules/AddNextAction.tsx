import { useState } from "react";
import { Button } from "../../../components/atoms/Button";
import { FeedbackMessage } from "../../../components/atoms/FeedbackMessage";
import type { EditOutcome } from "../../lib/edit-outcome";

const fieldClass = "w-full min-h-24 resize-y rounded-md border border-[var(--accent-blue)] bg-[var(--bg-surface)] px-2.5 py-2 text-sm! text-[var(--text-primary)]";

interface Props {
  isPending: boolean;
  onAdd: (text: string) => Promise<EditOutcome>;
}

/** A button that opens an empty action field; adding saves the trimmed text and closes it, or keeps it with the error when the save is refused. */
export function AddNextAction({ isPending, onAdd }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) {
    return <Button size="xsmall" className="self-start" disabled={isPending} onClick={() => setIsOpen(true)}>Add recommended next action</Button>;
  }

  const text = draft.trim();
  const close = () => { setDraft(""); setError(null); setIsOpen(false); };
  const add = async () => {
    const outcome = await onAdd(text);
    if (outcome.ok) close();
    else setError(outcome.error);
  };
  return (
    <div className="flex flex-col gap-2">
      <textarea className={fieldClass} aria-label="New recommended next action" value={draft} disabled={isPending}
        onChange={(event) => setDraft(event.target.value)} autoFocus />
      {error !== null && <FeedbackMessage tone="danger">Not saved: {error}</FeedbackMessage>}
      <div className="flex gap-2">
        <Button variant="primary" size="xsmall" disabled={isPending || text.length === 0}
          onClick={() => void add()}>Add action</Button>
        <Button size="xsmall" disabled={isPending} onClick={close}>Cancel</Button>
      </div>
    </div>
  );
}
