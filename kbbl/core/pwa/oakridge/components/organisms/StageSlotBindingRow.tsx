import { Button } from "../../../components/atoms/Button";
import type { SlotBinding } from "../../types";
import { BindingEditor } from "./BindingEditor";

interface StageSlotBindingRowProps {
  bindingKey: string;
  binding: SlotBinding;
  onChangeKey: (oldKey: string, newKey: string) => void;
  onChangeValue: (key: string, binding: SlotBinding) => void;
  onRemove: (key: string) => void;
  disabled: boolean;
}

const inputClass =
  "w-full rounded-md border border-[var(--border-muted)] bg-[var(--bg-surface)] px-3 py-1.5 text-sm text-[var(--text-primary)] focus:border-[var(--accent-blue)] focus:outline-none";

export function StageSlotBindingRow({ bindingKey, binding, onChangeKey, onChangeValue, onRemove, disabled }: StageSlotBindingRowProps) {
  return (
    <div className="flex flex-col gap-1 rounded border border-[var(--border-subtle)] p-2">
      <div className="flex items-center gap-2">
        <input type="text" className={inputClass} value={bindingKey}
          onChange={(event) => onChangeKey(bindingKey, event.target.value)}
          disabled={disabled} placeholder="SLOT_NAME" aria-label="Slot binding key" />
        <Button variant="danger" size="xsmall" onClick={() => onRemove(bindingKey)} disabled={disabled}>✕</Button>
      </div>
      <BindingEditor label="binding" value={binding}
        onChange={(next) => onChangeValue(bindingKey, next)} disabled={disabled} />
    </div>
  );
}
