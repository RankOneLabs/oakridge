import { defaultPlannerModelForRuntime, defaultWorkerModelForRuntime, type RuntimeId } from "../../../runtime";
import type { RuntimeDescriptors } from "../../hooks/useServerConfig";
import type { RuntimeDescriptor, RuntimeModelSelection } from "../../types";

export type ModelRole = "planner" | "worker";

export function runtimeForSelection(runtimeDescriptors: RuntimeDescriptors, defaultRuntimeId: RuntimeId, runtimeId: RuntimeId): RuntimeDescriptor {
  return runtimeDescriptors.find((runtime) => runtime.id === runtimeId) ?? runtimeDescriptors.find((runtime) => runtime.id === defaultRuntimeId) ?? runtimeDescriptors[0];
}

export function roleDefaultModel(role: ModelRole, runtime: RuntimeDescriptor): string {
  const preferred = role === "planner" ? defaultPlannerModelForRuntime(runtime.id) : defaultWorkerModelForRuntime(runtime.id);
  return runtime.models.some((option) => option.value === preferred) ? preferred : runtime.models[0]?.value ?? preferred;
}

export function initialSelectionForRole(role: ModelRole, runtimeDescriptors: RuntimeDescriptors, defaultRuntimeId: RuntimeId): RuntimeModelSelection {
  const runtime = runtimeForSelection(runtimeDescriptors, defaultRuntimeId, defaultRuntimeId);
  return { runtime: runtime.id, model: roleDefaultModel(role, runtime) };
}
