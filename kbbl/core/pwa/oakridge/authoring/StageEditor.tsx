import { useState } from "react";
import type { DelegatedSessionStageConfig, SlotBinding } from "../../oakridge/types";
import type { RuntimeModelOption } from "../../types";
import { BindingEditor, BindableEditor } from "./BindingEditor";
import { InputSlotEditor, OutputSlotEditor } from "./SlotEditor";
import { FanOutEditor } from "./FanOutEditor";
import { StageAdvancedSettings } from "../components/molecules/StageAdvancedSettings";
import type { StageFormEntry } from "./stage-form";

const inputClass =
  "w-full rounded-md border border-[var(--border-muted)] bg-[var(--bg-surface)] px-3 py-1.5 text-sm text-[var(--text-primary)] focus:border-[var(--accent-blue)] focus:outline-none";
const labelClass = "block text-xs font-medium text-[var(--text-muted)] mb-1";
const dangerBtnClass =
  "rounded border border-red-400 px-2 py-0.5 text-xs text-red-400 hover:bg-red-400 hover:text-white";
const addBtnClass =
  "rounded border border-[var(--border-muted)] px-2 py-0.5 text-xs text-[var(--text-secondary)] hover:border-[var(--border-hover)]";
const sectionClass =
  "flex flex-col gap-3 rounded-md border border-[var(--border-subtle)] p-3";

// Mirrors oakridge-core's DelegatedRuntime enum (VALID_RUNTIME_VALUES).
const RUNTIME_LITERAL_OPTIONS = [
  { value: "claude-code", label: "claude-code" },
  { value: "codex", label: "codex" },
];

interface ArtifactTypeOption {
  value: string;
  label: string;
}

interface StageEditorProps {
  stageKey: string;
  entry: StageFormEntry;
  onChangeKey: (newKey: string) => void;
  onChange: (patch: Partial<StageFormEntry>) => void;
  onRemove: () => void;
  artifactTypes: ArtifactTypeOption[];
  modelOptions: RuntimeModelOption[];
  effortOptions: RuntimeModelOption[];
  disabled?: boolean;
}

export function StageEditor({
  stageKey,
  entry,
  onChangeKey,
  onChange,
  onRemove,
  artifactTypes,
  modelOptions,
  effortOptions,
  disabled = false,
}: StageEditorProps) {
  const [collapsed, setCollapsed] = useState(false);
  const cfg = entry.config;
  const updateCfg = (patch: Partial<DelegatedSessionStageConfig>) =>
    onChange({ config: { ...cfg, ...patch } });

  // slot_bindings as ordered array for editing
  const slotBindingEntries = Object.entries(cfg.slot_bindings);

  const addSlotBinding = () => {
    // Find an unused name so a length-based name can't collide with a surviving
    // entry after removals and silently overwrite it.
    let n = Object.keys(cfg.slot_bindings).length;
    let key = `new_binding_${n}`;
    while (key in cfg.slot_bindings) key = `new_binding_${++n}`;
    const next = { ...cfg.slot_bindings, [key]: { from: "literal" as const, value: "" } };
    updateCfg({ slot_bindings: next });
  };

  const removeSlotBinding = (key: string) => {
    const next = { ...cfg.slot_bindings };
    delete next[key];
    updateCfg({ slot_bindings: next });
  };

  const updateSlotBindingKey = (oldKey: string, newKey: string) => {
    // Reject a rename that would collide with (and silently drop) another binding.
    if (newKey !== oldKey && newKey in cfg.slot_bindings) return;
    const next: Record<string, SlotBinding> = {};
    for (const [k, v] of Object.entries(cfg.slot_bindings)) {
      next[k === oldKey ? newKey : k] = v;
    }
    updateCfg({ slot_bindings: next });
  };

  const updateSlotBindingValue = (key: string, binding: SlotBinding) => {
    updateCfg({ slot_bindings: { ...cfg.slot_bindings, [key]: binding } });
  };

  return (
    <div className="flex flex-col gap-0 rounded-md border border-[var(--border-muted)]" data-testid="or-stage-editor">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
        <button
          type="button"
          className="text-xs text-[var(--text-muted)]"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "Expand stage" : "Collapse stage"}
        >
          {collapsed ? "▶" : "▼"}
        </button>
        <input
          type="text"
          className="flex-1 rounded border border-[var(--border-muted)] bg-[var(--bg-surface)] px-2 py-0.5 text-sm font-mono font-medium text-[var(--text-primary)]"
          value={stageKey}
          onChange={(e) => onChangeKey(e.target.value)}
          disabled={disabled}
          placeholder="stage_key"
          aria-label="Stage key"
        />
        <span className="rounded bg-[var(--bg-elevated)] px-2 py-0.5 text-xs text-[var(--text-muted)]">
          delegated_session
        </span>
        <button
          type="button"
          className={dangerBtnClass}
          onClick={onRemove}
          disabled={disabled}
          aria-label="Remove stage"
        >
          Remove
        </button>
      </div>

      {!collapsed && (
        <div className="flex flex-col gap-4 p-4">
          {/* Runtime */}
          <div className={sectionClass}>
            <span className="text-xs font-semibold uppercase text-[var(--text-muted)]">Session Config</span>
            <BindableEditor
              label="runtime"
              literalOptions={RUNTIME_LITERAL_OPTIONS}
              value={cfg.runtime}
              // `required`: runtime has no default, so onChange never yields null.
              onChange={(v) => updateCfg({ runtime: v ?? "claude-code" })}
              required
              pathPlaceholder="/planner_runtime"
              disabled={disabled}
            />

            <label className="flex flex-col gap-1">
              <span className={labelClass}>prompt_template_path</span>
              <input
                type="text"
                className={inputClass}
                value={cfg.prompt_template_path}
                onChange={(e) => updateCfg({ prompt_template_path: e.target.value })}
                disabled={disabled}
                placeholder="build.md"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className={labelClass}>session_name</span>
              <input
                type="text"
                className={inputClass}
                value={cfg.session_name}
                onChange={(e) => updateCfg({ session_name: e.target.value })}
                disabled={disabled}
                placeholder="build-session"
              />
            </label>

            <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
              <input
                type="checkbox"
                checked={cfg.yolo ?? false}
                onChange={(e) => updateCfg({ yolo: e.target.checked })}
                disabled={disabled}
              />
              <span className={labelClass + " mb-0"}>yolo (auto-accept tool calls)</span>
            </label>
          </div>

          {/* Model / Effort */}
          <div className={sectionClass}>
            <span className="text-xs font-semibold uppercase text-[var(--text-muted)]">Model / Effort</span>
            <BindableEditor
              label="model"
              literalOptions={modelOptions}
              value={cfg.model ?? null}
              onChange={(v) => updateCfg({ model: v ?? undefined })}
              disabled={disabled}
            />
            <BindableEditor
              label="effort"
              literalOptions={effortOptions}
              value={cfg.effort ?? null}
              onChange={(v) => updateCfg({ effort: v ?? undefined })}
              disabled={disabled}
            />
          </div>

          {/* Workdir */}
          <div className={sectionClass}>
            <span className="text-xs font-semibold uppercase text-[var(--text-muted)]">Workdir</span>
            <BindingEditor
              label="workdir"
              value={cfg.workdir}
              onChange={(b) => updateCfg({ workdir: b })}
              disabled={disabled}
            />
          </div>

          {/* Slot bindings */}
          <div className={sectionClass}>
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase text-[var(--text-muted)]">Slot Bindings</span>
              <button type="button" className={addBtnClass} onClick={addSlotBinding} disabled={disabled}>
                + Add
              </button>
            </div>
            {slotBindingEntries.length === 0 && (
              <p className="text-xs text-[var(--text-muted)]">No slot bindings.</p>
            )}
            {slotBindingEntries.map(([key, binding], i) => (
              <div key={i} className="flex flex-col gap-1 rounded border border-[var(--border-subtle)] p-2">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    className={inputClass}
                    value={key}
                    onChange={(e) => updateSlotBindingKey(key, e.target.value)}
                    disabled={disabled}
                    placeholder="SLOT_NAME"
                    aria-label="Slot binding key"
                  />
                  <button
                    type="button"
                    className={dangerBtnClass}
                    onClick={() => removeSlotBinding(key)}
                    disabled={disabled}
                  >
                    ✕
                  </button>
                </div>
                <BindingEditor
                  label="binding"
                  value={binding}
                  onChange={(b) => updateSlotBindingValue(key, b)}
                  disabled={disabled}
                />
              </div>
            ))}
          </div>

          {/* Gate output */}
          <div className={sectionClass}>
            <span className="text-xs font-semibold uppercase text-[var(--text-muted)]">Gate Output</span>
            <label className="flex flex-col gap-1">
              <span className={labelClass}>gate_output (optional — output slot that parks the unit)</span>
              <select
                className={inputClass}
                value={cfg.gate_output ?? ""}
                onChange={(e) => updateCfg({ gate_output: e.target.value || null })}
                disabled={disabled}
              >
                <option value="">— first output (default) —</option>
                {entry.outputs.map((o) => (
                  <option key={o.name} value={o.name}>{o.name}</option>
                ))}
              </select>
            </label>
          </div>

          {/* Slots */}
          <div className={sectionClass}>
            <span className="text-xs font-semibold uppercase text-[var(--text-muted)]">Input / Output Slots</span>
            <InputSlotEditor
              slots={entry.inputs}
              onChange={(inputs) => onChange({ inputs })}
              artifactTypes={artifactTypes}
              disabled={disabled}
            />
            <OutputSlotEditor
              slots={entry.outputs}
              onChange={(outputs) => onChange({ outputs })}
              artifactTypes={artifactTypes}
              disabled={disabled}
            />
          </div>

          {/* Fan out */}
          <div className={sectionClass}>
            <span className="text-xs font-semibold uppercase text-[var(--text-muted)]">Fan Out (multi-unit)</span>
            <FanOutEditor
              value={cfg.fan_out ?? null}
              onChange={(fo) => updateCfg({ fan_out: fo ?? undefined })}
              disabled={disabled}
            />
          </div>

          <StageAdvancedSettings config={cfg} onChange={updateCfg} isDisabled={disabled} />
        </div>
      )}
    </div>
  );
}
