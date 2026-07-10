import type { InputSlotDef, OutputSlotDef } from "../../oakridge/types";

const inputClass =
  "w-full rounded-md border border-[var(--border-muted)] bg-[var(--bg-surface)] px-3 py-1.5 text-sm text-[var(--text-primary)] focus:border-[var(--accent-blue)] focus:outline-none";
const labelClass = "block text-xs font-medium text-[var(--text-muted)] mb-1";
const dangerBtnClass =
  "rounded border border-red-400 px-2 py-0.5 text-xs text-red-400 hover:bg-red-400 hover:text-white";
const addBtnClass =
  "rounded border border-[var(--border-muted)] px-2 py-0.5 text-xs text-[var(--text-secondary)] hover:border-[var(--border-hover)]";

interface ArtifactTypeOption {
  value: string;
  label: string;
}

interface InputSlotEditorProps {
  slots: InputSlotDef[];
  onChange: (slots: InputSlotDef[]) => void;
  artifactTypes: ArtifactTypeOption[];
  disabled?: boolean;
}

export function InputSlotEditor({
  slots,
  onChange,
  artifactTypes,
  disabled = false,
}: InputSlotEditorProps) {
  const addSlot = () =>
    onChange([
      ...slots,
      {
        name: "",
        artifact_type: artifactTypes[0]?.value ?? "",
        optional: false,
        collect: false,
      },
    ]);
  const removeSlot = (i: number) => onChange(slots.filter((_, idx) => idx !== i));
  const updateSlot = (i: number, patch: Partial<InputSlotDef>) =>
    onChange(slots.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className={labelClass}>Input slots</span>
        <button type="button" className={addBtnClass} onClick={addSlot} disabled={disabled || artifactTypes.length === 0}>
          + Add
        </button>
      </div>
      {slots.length === 0 && (
        <p className="text-xs text-[var(--text-muted)]">No input slots.</p>
      )}
      {slots.map((slot, i) => (
        <div key={i} className="flex items-start gap-2 rounded border border-[var(--border-subtle)] p-2">
          <div className="flex flex-1 flex-col gap-1">
            <input
              type="text"
              className={inputClass}
              value={slot.name}
              onChange={(e) => updateSlot(i, { name: e.target.value })}
              disabled={disabled}
              placeholder="slot name"
              aria-label={`Input slot ${i + 1} name`}
            />
            <select
              className={inputClass}
              value={slot.artifact_type}
              onChange={(e) => updateSlot(i, { artifact_type: e.target.value })}
              disabled={disabled}
              aria-label={`Input slot ${i + 1} artifact type`}
            >
              {artifactTypes.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
              <input
                type="checkbox"
                checked={slot.optional ?? false}
                onChange={(e) => updateSlot(i, { optional: e.target.checked })}
                disabled={disabled}
              />
              Optional
            </label>
            <label className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
              <input
                type="checkbox"
                checked={slot.collect ?? false}
                onChange={(e) => updateSlot(i, { collect: e.target.checked })}
                disabled={disabled}
              />
              Collect producer units
            </label>
          </div>
          <button
            type="button"
            className={dangerBtnClass}
            onClick={() => removeSlot(i)}
            disabled={disabled}
            aria-label={`Remove input slot ${i + 1}`}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

interface OutputSlotEditorProps {
  slots: OutputSlotDef[];
  onChange: (slots: OutputSlotDef[]) => void;
  artifactTypes: ArtifactTypeOption[];
  disabled?: boolean;
}

export function OutputSlotEditor({
  slots,
  onChange,
  artifactTypes,
  disabled = false,
}: OutputSlotEditorProps) {
  const addSlot = () =>
    onChange([...slots, { name: "", artifact_type: artifactTypes[0]?.value ?? "" }]);
  const removeSlot = (i: number) => onChange(slots.filter((_, idx) => idx !== i));
  const updateSlot = (i: number, patch: Partial<OutputSlotDef>) =>
    onChange(slots.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className={labelClass}>Output slots</span>
        <button type="button" className={addBtnClass} onClick={addSlot} disabled={disabled || artifactTypes.length === 0}>
          + Add
        </button>
      </div>
      {slots.length === 0 && (
        <p className="text-xs text-[var(--text-muted)]">No output slots.</p>
      )}
      {slots.map((slot, i) => (
        <div key={i} className="flex items-start gap-2 rounded border border-[var(--border-subtle)] p-2">
          <div className="flex flex-1 flex-col gap-1">
            <input
              type="text"
              className={inputClass}
              value={slot.name}
              onChange={(e) => updateSlot(i, { name: e.target.value })}
              disabled={disabled}
              placeholder="slot name"
              aria-label={`Output slot ${i + 1} name`}
            />
            <select
              className={inputClass}
              value={slot.artifact_type}
              onChange={(e) => updateSlot(i, { artifact_type: e.target.value })}
              disabled={disabled}
              aria-label={`Output slot ${i + 1} artifact type`}
            >
              {artifactTypes.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className={dangerBtnClass}
            onClick={() => removeSlot(i)}
            disabled={disabled}
            aria-label={`Remove output slot ${i + 1}`}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
