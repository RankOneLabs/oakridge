import { useState } from "react";
import { Button } from "../../../components/atoms/Button";
import { Select } from "../../../components/atoms/Select";
import { TextArea } from "../../../components/atoms/TextArea";
import type { AddedActionInput, AdjudicationSourceOption } from "../../lib/assessment-adjudication";

interface Props {
  sources: readonly AdjudicationSourceOption[];
  disabled: boolean;
  onAdd: (input: AddedActionInput) => void;
}

/** An operator-written action, behind a button until the operator wants one. */
export function AddAdjudicationAction({ sources, disabled, onAdd }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [audience, setAudience] = useState<AddedActionInput["audience"]>("rework");
  const [source, setSource] = useState(sources[0]?.value ?? "");
  const [text, setText] = useState("");
  if (!isOpen) return <Button size="small" variant="secondary" className="self-start" disabled={disabled} onClick={() => setIsOpen(true)}>+ Add action</Button>;
  function add(): void {
    const option = sources.find(candidate => candidate.value === source);
    if (!option || !text.trim()) return;
    onAdd({ audience, source: option.source, text });
    setText("");
    setIsOpen(false);
  }
  return <section aria-label="Add action" className="flex flex-col gap-2 rounded-md border border-[var(--border-decorative)] p-3">
    <label className="flex flex-col gap-1 text-xs">Action<TextArea aria-label="Added action text" disabled={disabled} value={text} onChange={event => setText(event.target.value)} /></label>
    <div className="flex flex-wrap gap-2">
      <label className="text-xs">For <Select aria-label="Added action audience" disabled={disabled} value={audience} onChange={event => setAudience(event.target.value as AddedActionInput["audience"])}>
        <option value="rework">Rework</option><option value="operator">Operator</option></Select></label>
      <label className="text-xs">Supporting <Select aria-label="Supporting item or finding" disabled={disabled} value={source} onChange={event => setSource(event.target.value)}>
        {sources.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></label>
    </div>
    <div className="flex gap-2">
      <Button size="small" disabled={disabled || !text.trim() || !source} onClick={add}>Add</Button>
      <Button size="small" variant="secondary" onClick={() => setIsOpen(false)}>Cancel</Button>
    </div>
  </section>;
}
