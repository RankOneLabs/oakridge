import { defaultModelForRuntime, type RuntimeId } from "../../../runtime";
import type { RuntimeDescriptors } from "../../hooks/useServerConfig";
import type { RuntimeDescriptor } from "../../types";

export type ModelRole = "planner" | "worker";
/** One role's launch choice: the runtime, model and optional effort its sessions start with. */
export interface RoleSelection { readonly runtime: RuntimeId; readonly model: string; readonly effort?: string }

export function runtimeForSelection(runtimeDescriptors: RuntimeDescriptors, defaultRuntimeId: RuntimeId, runtimeId: RuntimeId): RuntimeDescriptor {
  return runtimeDescriptors.find((runtime) => runtime.id === runtimeId) ?? runtimeDescriptors.find((runtime) => runtime.id === defaultRuntimeId) ?? runtimeDescriptors[0];
}

export function roleDefaultModel(runtime: RuntimeDescriptor): string {
  const preferred = defaultModelForRuntime(runtime.id);
  return runtime.models.some((option) => option.value === preferred) ? preferred : runtime.models[0]?.value ?? preferred;
}

export function initialSelectionForRole(runtimeDescriptors: RuntimeDescriptors, defaultRuntimeId: RuntimeId): RoleSelection {
  const runtime = runtimeForSelection(runtimeDescriptors, defaultRuntimeId, defaultRuntimeId);
  return { runtime: runtime.id, model: roleDefaultModel(runtime) };
}

/** Reconcile the fallback selection with the server's advertised runtime options. */
export function coerceRoleSelection(selection: RoleSelection, runtimeDescriptors: RuntimeDescriptors,
  defaultRuntimeId: RuntimeId, runtimeTouched: boolean): RoleSelection {
  const runtime = runtimeForSelection(runtimeDescriptors, defaultRuntimeId, runtimeTouched ? selection.runtime : defaultRuntimeId);
  const effort = runtime.id === selection.runtime && runtime.efforts.some((option) => option.value === selection.effort)
    ? selection.effort : undefined;
  const model = runtime.models.length === 0
    ? selection.model.trim() || roleDefaultModel(runtime)
    : runtime.models.some((option) => option.value === selection.model) ? selection.model : roleDefaultModel(runtime);
  if (runtime.id === selection.runtime && model === selection.model && effort === selection.effort) return selection;
  return effort === undefined ? { runtime: runtime.id, model } : { runtime: runtime.id, model, effort };
}
