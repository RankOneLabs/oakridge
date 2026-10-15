import type { SlotBinding } from "../../types";

type LookupBinding = Extract<SlotBinding, { from: "input_lookup" | "context_lookup" }>;

interface BindingLookupFieldsProps {
  value: LookupBinding;
  onChange: (binding: SlotBinding) => void;
  disabled: boolean;
}

const inputClass =
  "w-full rounded-md border border-[var(--border-muted)] bg-[var(--bg-surface)] px-3 py-1.5 text-sm text-[var(--text-primary)] focus:border-[var(--accent-blue)] focus:outline-none";
const labelClass = "block text-xs font-medium text-[var(--text-muted)] mb-1";

export function BindingLookupFields({ value, onChange, disabled }: BindingLookupFieldsProps) {
  if (value.from === "input_lookup") {
    return (
      <div className="grid grid-cols-2 gap-2">
        {([
          ["Input name", "input_name", "repository_refs"],
          ["Collection key path", "collection_key_path", "/artifact/repository_key"],
          ["Item key path", "item_key_path", "/artifact/repository_key"],
          ["Value path", "value_path", "/artifact/repository_path"],
        ] as const).map(([fieldLabel, field, placeholder]) => (
          <label className="flex flex-col gap-1" key={field}>
            <span className={labelClass}>{fieldLabel}</span>
            <input type="text" className={inputClass} value={value[field]}
              onChange={(event) => onChange({ ...value, [field]: event.target.value })}
              disabled={disabled} placeholder={placeholder} />
          </label>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      {([
        ["Collection context path", "collection_path", "/repositories"],
        ["Collection key path", "collection_key_path", "/key"],
        ["Item key path", "item_key_path", "/repository_key"],
        ["Value path", "value_path", "/path"],
      ] as const).map(([fieldLabel, field, placeholder]) => (
        <label className="flex flex-col gap-1" key={field}>
          <span className={labelClass}>{fieldLabel}</span>
          <input type="text" className={inputClass} value={value[field]}
            onChange={(event) => onChange({ ...value, [field]: event.target.value })}
            disabled={disabled} placeholder={placeholder} />
        </label>
      ))}
    </div>
  );
}
