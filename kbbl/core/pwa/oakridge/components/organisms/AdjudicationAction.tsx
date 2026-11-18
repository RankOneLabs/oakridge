import { TextArea } from "../../../components/atoms/TextArea";
import { useState } from "react";
import { Button } from "../../../components/atoms/Button";
import { Chip } from "../../../components/atoms/Chip";
import type { OperatorAssessmentAction } from "../../operator-contracts/domain/assessment";
import type { DispositionChoice, PendingDisposition } from "../../lib/assessment-handoff";
interface Props { action: OperatorAssessmentAction; pending: PendingDisposition; disabled: boolean; onChange: (choice: DispositionChoice) => void }
export function AdjudicationAction({ action, pending, disabled, onChange }: Props) {
  const [mode, setMode] = useState<"edit" | "reject" | null>(null);
  const [text, setText] = useState(action.text);
  const [reason, setReason] = useState("");
  return <li className="flex flex-col gap-2 rounded-md border border-[var(--border-decorative)] p-3">
    <p><code>{action.id}</code> <Chip tone="neutral">Pending{pending.kind === "decided" ? `: ${pending.disposition}` : ": undecided"}</Chip></p>
    <p>Original: {action.text}</p><p className="text-xs">Supporting {action.source.kind}: {action.source.id}</p>
    <div className="flex gap-2">
      <Button size="xsmall" disabled={disabled} onClick={() => { setMode(null); onChange({ kind: "accept" }); }}>Accept</Button>
      <Button size="xsmall" disabled={disabled} onClick={() => { setMode("edit"); onChange({ kind: "edit", final_text: text }); }}>Edit</Button>
      <Button size="xsmall" disabled={disabled} onClick={() => { setMode("reject"); onChange({ kind: "reject", reason }); }}>Reject</Button>
    </div>
    {mode === "edit" && <label>Replacement text<TextArea aria-label={`Replacement for ${action.id}`} value={text} disabled={disabled} onChange={event => { setText(event.target.value); onChange({ kind: "edit", final_text: event.target.value }); }} /></label>}
    {mode === "reject" && <label>Reason (optional)<TextArea aria-label={`Rejection reason for ${action.id}`} value={reason} disabled={disabled} onChange={event => { setReason(event.target.value); onChange({ kind: "reject", reason: event.target.value }); }} /></label>}
  </li>;
}
