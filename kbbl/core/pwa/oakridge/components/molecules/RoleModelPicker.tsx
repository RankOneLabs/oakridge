import type { RuntimeId } from "../../../../runtime";
import type { RuntimeModelSelection } from "../../../types";
import type { RuntimeDescriptors } from "../../../hooks/useServerConfig";
import { roleDefaultModel, runtimeForSelection, type ModelRole } from "../../lib/runtime-selection";

const fieldLabelClass = "block text-xs font-medium text-[var(--text-muted)] mb-1";
const inputClass = "w-full rounded-md border border-[var(--border-muted)] bg-[var(--bg-surface)] px-3 py-1.5 text-sm text-[var(--text-primary)] focus:border-[var(--accent-blue)] focus:outline-none";

type SetSelection = (value: RuntimeModelSelection | ((current: RuntimeModelSelection) => RuntimeModelSelection)) => void;

interface RoleModelPickerProps {
  role: ModelRole;
  selection: RuntimeModelSelection;
  setSelection: SetSelection;
  setRuntimeTouched: (isTouched: boolean) => void;
  runtimeDescriptors: RuntimeDescriptors;
  defaultRuntimeId: RuntimeId;
  isPending: boolean;
}

export function RoleModelPicker({ role, selection, setSelection, setRuntimeTouched, runtimeDescriptors, defaultRuntimeId, isPending }: RoleModelPickerProps) {
  const roleLabel = role === "planner" ? "Planner" : "Worker";
  const runtime = runtimeForSelection(runtimeDescriptors, defaultRuntimeId, selection.runtime);
  return (
    <section className="flex flex-col gap-2 rounded-md border border-[var(--border-subtle)] p-3">
      <div className="text-xs font-semibold uppercase text-[var(--text-muted)]">{roleLabel}</div>
      <label className="flex flex-col gap-1"><span className={fieldLabelClass}>Runtime</span>
        <select className={inputClass} value={selection.runtime} onChange={(event) => {
          const nextRuntime = runtimeForSelection(runtimeDescriptors, defaultRuntimeId, event.target.value as RuntimeId);
          setRuntimeTouched(true);
          setSelection({ runtime: nextRuntime.id, model: roleDefaultModel(role, nextRuntime) });
        }} disabled={isPending} aria-label={`${roleLabel} runtime`}>
          {runtimeDescriptors.map((descriptor) => <option key={descriptor.id} value={descriptor.id}>{descriptor.label}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1"><span className={fieldLabelClass}>Model</span>
        {runtime.models.length > 0 ? <select className={inputClass} value={selection.model} onChange={(event) => setSelection((current) => ({ ...current, model: event.target.value }))} disabled={isPending} aria-label={`${roleLabel} model`}>
          {runtime.models.map((option) => <option key={option.value || "default"} value={option.value}>{option.label}</option>)}
        </select> : <input type="text" className={inputClass} value={selection.model} onChange={(event) => setSelection((current) => ({ ...current, model: event.target.value }))} disabled={isPending} aria-label={`${roleLabel} model`} spellCheck={false} />}
      </label>
      {runtime.efforts.length > 0 && <label className="flex flex-col gap-1"><span className={fieldLabelClass}>Effort</span>
        <select className={inputClass} value={selection.effort ?? ""} onChange={(event) => setSelection((current) => ({ ...current, effort: event.target.value || undefined }))} disabled={isPending} aria-label={`${roleLabel} effort`}>
          {[{ value: "", label: "default" }, ...runtime.efforts].map((option) => <option key={option.value || "default"} value={option.value}>{option.label}</option>)}
        </select>
      </label>}
    </section>
  );
}
