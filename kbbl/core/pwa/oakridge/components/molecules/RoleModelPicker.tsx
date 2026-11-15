import { TextInput } from "../../../components/atoms/TextInput";
import { Select } from "../../../components/atoms/Select";
import type { RuntimeId } from "../../../../runtime";
import type { RuntimeModelSelection } from "../../../types";
import type { RuntimeDescriptors } from "../../../hooks/useServerConfig";
import { roleDefaultModel, runtimeForSelection, type ModelRole } from "../../lib/runtime-selection";

const fieldLabelClass = "block text-xs font-medium text-[var(--text-muted)] mb-1";

type SetSelection = (value: RuntimeModelSelection | ((current: RuntimeModelSelection) => RuntimeModelSelection)) => void;

interface RoleModelPickerProps {
  role: ModelRole;
  label?: string;
  selection: RuntimeModelSelection;
  setSelection: SetSelection;
  setRuntimeTouched: (isTouched: boolean) => void;
  runtimeDescriptors: RuntimeDescriptors;
  defaultRuntimeId: RuntimeId;
  isPending: boolean;
}

export function RoleModelPicker({ role, label, selection, setSelection, setRuntimeTouched, runtimeDescriptors, defaultRuntimeId, isPending }: RoleModelPickerProps) {
  const roleLabel = label ?? (role === "planner" ? "Planner" : "Worker");
  const runtime = runtimeForSelection(runtimeDescriptors, defaultRuntimeId, selection.runtime);
  return (
    <section className="flex flex-col gap-2 rounded-md border border-[var(--border-decorative)] p-3">
      <div className="text-xs font-semibold uppercase text-[var(--text-muted)]">{roleLabel}</div>
      <label className="flex flex-col gap-1"><span className={fieldLabelClass}>Runtime</span>
        <Select  value={selection.runtime} onChange={(event) => {
          const nextRuntime = runtimeForSelection(runtimeDescriptors, defaultRuntimeId, event.target.value as RuntimeId);
          setRuntimeTouched(true);
          setSelection({ runtime: nextRuntime.id, model: roleDefaultModel(role, nextRuntime) });
        }} disabled={isPending} aria-label={`${roleLabel} runtime`}>
          {runtimeDescriptors.map((descriptor) => <option key={descriptor.id} value={descriptor.id}>{descriptor.label}</option>)}
        </Select>
      </label>
      <label className="flex flex-col gap-1"><span className={fieldLabelClass}>Model</span>
        {runtime.models.length > 0 ? <Select  value={selection.model} onChange={(event) => setSelection((current) => ({ ...current, model: event.target.value }))} disabled={isPending} aria-label={`${roleLabel} model`}>
          {runtime.models.map((option) => <option key={option.value || "default"} value={option.value}>{option.label}</option>)}
        </Select> : <TextInput type="text"  value={selection.model} onChange={(event) => setSelection((current) => ({ ...current, model: event.target.value }))} disabled={isPending} aria-label={`${roleLabel} model`} spellCheck={false} />}
      </label>
      {runtime.efforts.length > 0 && <label className="flex flex-col gap-1"><span className={fieldLabelClass}>Effort</span>
        <Select  value={selection.effort ?? ""} onChange={(event) => setSelection((current) => ({ ...current, effort: event.target.value || undefined }))} disabled={isPending} aria-label={`${roleLabel} effort`}>
          {[{ value: "", label: "default" }, ...runtime.efforts].map((option) => <option key={option.value || "default"} value={option.value}>{option.label}</option>)}
        </Select>
      </label>}
    </section>
  );
}
