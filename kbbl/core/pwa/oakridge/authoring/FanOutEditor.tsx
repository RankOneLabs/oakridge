import type { FanOutConfig, SlotBinding } from "../../oakridge/types";
import { BindingEditor } from "./BindingEditor";

const inputClass =
  "w-full rounded-md border border-[var(--border-muted)] bg-[var(--bg-surface)] px-3 py-1.5 text-sm text-[var(--text-primary)] focus:border-[var(--accent-blue)] focus:outline-none";
const labelClass = "block text-xs font-medium text-[var(--text-muted)] mb-1";
const addBtnClass =
  "rounded border border-[var(--border-muted)] px-2 py-0.5 text-xs text-[var(--text-secondary)] hover:border-[var(--border-hover)]";
const dangerBtnClass =
  "rounded border border-red-400 px-2 py-0.5 text-xs text-red-400 hover:bg-red-400 hover:text-white";

function defaultFanOut(): FanOutConfig {
  return {
    over: { from: "input", input_name: "", path: null },
    unit_id_path: "/id",
    depends_on_path: null,
    max_parallel: 8,
    item_bindings: {},
    worktree: null,
  };
}

interface FanOutEditorProps {
  value: FanOutConfig | null;
  onChange: (v: FanOutConfig | null) => void;
  disabled?: boolean;
}

export function FanOutEditor({ value, onChange, disabled = false }: FanOutEditorProps) {
  const enabled = value !== null;

  const toggle = () => onChange(enabled ? null : defaultFanOut());

  if (!enabled) {
    return (
      <div className="flex items-center gap-2">
        <button type="button" className={addBtnClass} onClick={toggle} disabled={disabled}>
          + Enable fan_out
        </button>
        <span className="text-xs text-[var(--text-muted)]">N=1 single unit (default)</span>
      </div>
    );
  }

  const fo = value;

  const update = (patch: Partial<FanOutConfig>) => onChange({ ...fo, ...patch });

  // item_bindings as array for editing
  const itemBindings = Object.entries(fo.item_bindings ?? {});

  const addItemBinding = () => {
    const next = { ...fo.item_bindings, "": { from: "item" as const, path: "" } };
    update({ item_bindings: next });
  };

  const removeItemBinding = (key: string) => {
    const next = { ...fo.item_bindings };
    delete next[key];
    update({ item_bindings: next });
  };

  const updateItemBindingKey = (oldKey: string, newKey: string) => {
    const next: Record<string, SlotBinding> = {};
    for (const [k, v] of Object.entries(fo.item_bindings ?? {})) {
      next[k === oldKey ? newKey : k] = v;
    }
    update({ item_bindings: next });
  };

  const updateItemBinding = (key: string, binding: SlotBinding) => {
    update({ item_bindings: { ...fo.item_bindings, [key]: binding } });
  };

  const hasWorktree = fo.worktree !== null && fo.worktree !== undefined;

  return (
    <div className="flex flex-col gap-3 rounded-md border border-[var(--border-subtle)] p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase text-[var(--text-muted)]">Fan Out</span>
        <button type="button" className={dangerBtnClass} onClick={toggle} disabled={disabled}>
          Remove
        </button>
      </div>

      <BindingEditor
        label="over (source array)"
        value={fo.over}
        onChange={(b) => update({ over: b })}
        disabled={disabled}
      />

      <label className="flex flex-col gap-1">
        <span className={labelClass}>unit_id_path (RFC-6901 pointer)</span>
        <input
          type="text"
          className={inputClass}
          value={fo.unit_id_path}
          onChange={(e) => update({ unit_id_path: e.target.value })}
          disabled={disabled}
          placeholder="/id"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className={labelClass}>depends_on_path (optional)</span>
        <input
          type="text"
          className={inputClass}
          value={fo.depends_on_path ?? ""}
          onChange={(e) => update({ depends_on_path: e.target.value || null })}
          disabled={disabled}
          placeholder="/depends_on"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className={labelClass}>max_parallel (default 8)</span>
        <input
          type="number"
          className={inputClass}
          value={fo.max_parallel ?? 8}
          min={1}
          onChange={(e) => update({ max_parallel: Math.max(1, parseInt(e.target.value, 10) || 8) })}
          disabled={disabled}
        />
      </label>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className={labelClass}>item_bindings</span>
          <button type="button" className={addBtnClass} onClick={addItemBinding} disabled={disabled}>
            + Add
          </button>
        </div>
        {itemBindings.map(([key, binding]) => (
          <div key={key} className="flex flex-col gap-1 rounded border border-[var(--border-subtle)] p-2">
            <div className="flex items-center gap-2">
              <input
                type="text"
                className={inputClass}
                value={key}
                onChange={(e) => updateItemBindingKey(key, e.target.value)}
                disabled={disabled}
                placeholder="slot key (e.g. BRIEF)"
                aria-label="Item binding slot key"
              />
              <button
                type="button"
                className={dangerBtnClass}
                onClick={() => removeItemBinding(key)}
                disabled={disabled}
              >
                ✕
              </button>
            </div>
            <BindingEditor
              label="binding"
              value={binding}
              onChange={(b) => updateItemBinding(key, b)}
              allowItem
              disabled={disabled}
            />
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className={labelClass}>Worktree template</span>
          <button
            type="button"
            className={addBtnClass}
            onClick={() =>
              update({
                worktree: hasWorktree
                  ? null
                  : { branch_name: "cohort/{{UNIT_ID}}", worktree_subdir: "wt/{{UNIT_ID}}", base_ref: null },
              })
            }
            disabled={disabled}
          >
            {hasWorktree ? "Remove" : "+ Add"}
          </button>
        </div>
        {hasWorktree && fo.worktree && (
          <div className="flex flex-col gap-1 rounded border border-[var(--border-subtle)] p-2">
            <label className="flex flex-col gap-1">
              <span className={labelClass}>branch_name (use {"{{UNIT_ID}}"} / {"{{STAGE_INSTANCE_ID}}"})</span>
              <input
                type="text"
                className={inputClass}
                value={fo.worktree.branch_name}
                onChange={(e) =>
                  update({ worktree: { ...fo.worktree!, branch_name: e.target.value } })
                }
                disabled={disabled}
                placeholder="cohort/{{UNIT_ID}}"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={labelClass}>worktree_subdir</span>
              <input
                type="text"
                className={inputClass}
                value={fo.worktree.worktree_subdir}
                onChange={(e) =>
                  update({ worktree: { ...fo.worktree!, worktree_subdir: e.target.value } })
                }
                disabled={disabled}
                placeholder="wt/{{UNIT_ID}}"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={labelClass}>base_ref (optional)</span>
              <input
                type="text"
                className={inputClass}
                value={fo.worktree.base_ref ?? ""}
                onChange={(e) =>
                  update({
                    worktree: { ...fo.worktree!, base_ref: e.target.value || null },
                  })
                }
                disabled={disabled}
                placeholder="main"
              />
            </label>
          </div>
        )}
      </div>
    </div>
  );
}
