import type { SlotBinding, SlotBindingSource } from "../../oakridge/types";

const inputClass =
  "w-full rounded-md border border-[var(--border-muted)] bg-[var(--bg-surface)] px-3 py-1.5 text-sm text-[var(--text-primary)] focus:border-[var(--accent-blue)] focus:outline-none";
const selectClass = inputClass;
const labelClass = "block text-xs font-medium text-[var(--text-muted)] mb-1";

interface BindingEditorProps {
  label: string;
  value: SlotBinding;
  onChange: (binding: SlotBinding) => void;
  // When true, the "item" source is available (inside a fan_out context)
  allowItem?: boolean;
  disabled?: boolean;
}

function defaultForSource(source: SlotBindingSource): SlotBinding {
  if (source === "input") return { from: "input", input_name: "", path: null };
  if (source === "context") return { from: "context", path: "" };
  if (source === "item") return { from: "item", path: "" };
  return { from: "literal", value: "" };
}

export function BindingEditor({
  label,
  value,
  onChange,
  allowItem = false,
  disabled = false,
}: BindingEditorProps) {
  // Derive the select's value directly from `value.from` rather than mirroring it
  // in local state — a mirror would go stale when the parent replaces `value`
  // (clone/load a def, reset bindings, async load resolving after mount).
  const onSourceChange = (next: SlotBindingSource) => {
    onChange(defaultForSource(next));
  };

  const sources: SlotBindingSource[] = ["literal", "input", "context"];
  if (allowItem) sources.push("item");

  return (
    <div className="flex flex-col gap-2 rounded-md border border-[var(--border-subtle)] p-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-[var(--text-secondary)]">{label}</span>
        <select
          className="rounded border border-[var(--border-muted)] bg-[var(--bg-surface)] px-2 py-0.5 text-xs text-[var(--text-secondary)]"
          value={value.from}
          onChange={(e) => onSourceChange(e.target.value as SlotBindingSource)}
          disabled={disabled}
          aria-label={`${label} binding source`}
        >
          {sources.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      {value.from === "literal" && (
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Value</span>
          <input
            type="text"
            className={inputClass}
            value={value.value}
            onChange={(e) => onChange({ from: "literal", value: e.target.value })}
            disabled={disabled}
            placeholder="static value"
          />
        </label>
      )}

      {value.from === "input" && (
        <>
          <label className="flex flex-col gap-1">
            <span className={labelClass}>Input name</span>
            <input
              type="text"
              className={inputClass}
              value={value.input_name}
              onChange={(e) =>
                onChange({ from: "input", input_name: e.target.value, path: value.path ?? null })
              }
              disabled={disabled}
              placeholder="slot name (e.g. plan)"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelClass}>JSON pointer (optional)</span>
            <input
              type="text"
              className={inputClass}
              value={value.path ?? ""}
              onChange={(e) =>
                onChange({
                  from: "input",
                  input_name: value.input_name,
                  path: e.target.value || null,
                })
              }
              disabled={disabled}
              placeholder="/field/path"
            />
          </label>
        </>
      )}

      {value.from === "context" && (
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Context path</span>
          <input
            type="text"
            className={inputClass}
            value={value.path}
            onChange={(e) => onChange({ from: "context", path: e.target.value })}
            disabled={disabled}
            placeholder="/planner_model"
          />
        </label>
      )}

      {value.from === "item" && (
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Item path</span>
          <input
            type="text"
            className={inputClass}
            value={value.path}
            onChange={(e) => onChange({ from: "item", path: e.target.value })}
            disabled={disabled}
            placeholder="/field"
          />
        </label>
      )}
    </div>
  );
}

// ── BindableEditor ────────────────────────────────────────────────────────────
// For model/effort fields: toggle between "none", "literal", and "context binding".

type BindableMode = "none" | "literal" | "context";

interface BindableEditorProps {
  label: string;
  literalOptions?: Array<{ value: string; label: string }>;
  value: string | SlotBinding | null | undefined;
  onChange: (v: string | SlotBinding | null) => void;
  disabled?: boolean;
}

function detectMode(v: string | SlotBinding | null | undefined): BindableMode {
  if (v == null) return "none";
  if (typeof v === "string") return "literal";
  return "context";
}

export function BindableEditor({
  label,
  literalOptions,
  value,
  onChange,
  disabled = false,
}: BindableEditorProps) {
  const mode = detectMode(value);

  const onModeChange = (next: BindableMode) => {
    if (next === "none") onChange(null);
    else if (next === "literal") onChange(literalOptions?.[0]?.value ?? "");
    else onChange({ from: "context", path: "" });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className={`${selectClass.split(" ")[0]} text-xs font-medium text-[var(--text-secondary)]`}>{label}</span>
        <select
          className="rounded border border-[var(--border-muted)] bg-[var(--bg-surface)] px-2 py-0.5 text-xs text-[var(--text-secondary)]"
          value={mode}
          onChange={(e) => onModeChange(e.target.value as BindableMode)}
          disabled={disabled}
          aria-label={`${label} mode`}
        >
          <option value="none">— default —</option>
          <option value="literal">literal</option>
          <option value="context">context binding</option>
        </select>
      </div>

      {mode === "literal" && (
        <>
          {literalOptions && literalOptions.length > 0 ? (
            <select
              className={selectClass}
              value={typeof value === "string" ? value : ""}
              onChange={(e) => onChange(e.target.value)}
              disabled={disabled}
              aria-label={`${label} value`}
            >
              {literalOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              className={inputClass}
              value={typeof value === "string" ? value : ""}
              onChange={(e) => onChange(e.target.value)}
              disabled={disabled}
              placeholder="model string"
            />
          )}
        </>
      )}

      {mode === "context" && typeof value === "object" && value !== null && "from" in value && value.from === "context" && (
        <input
          type="text"
          className={inputClass}
          value={value.path}
          onChange={(e) => onChange({ from: "context", path: e.target.value })}
          disabled={disabled}
          placeholder="/planner_model"
        />
      )}
    </div>
  );
}
