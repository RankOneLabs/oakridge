// Runtime identity + launch/config surface (§12, §20.2).
//
// The provider-adapter contract (AgentRuntime, RuntimeRegistry,
// classifyEvent, the RuntimeEvent union, the conformance harness) is gone
// with the legacy per-session state machine — the ACP substrate
// (core/acp/*) replaced it, and no adapter ever implemented this contract
// against ACP. What survives here is the small vocabulary the launch and
// config surfaces still use directly: which runtime ids exist, their
// descriptors (label/models/efforts), and default-model lookup.

export type RuntimeId = "claude-code" | "codex";

export interface RuntimeDescriptor {
  id: RuntimeId;
  label: string;
  models: readonly { value: string; label: string }[];
  /**
   * Reasoning/effort levels this runtime accepts, most-effort-last. Empty for
   * runtimes with no effort control. The PWA renders these as an effort picker
   * (prepending a "default" = unset option) exactly as it does `models`. Values
   * differ per runtime (CC: low..max; Codex: minimal..max), so each adapter
   * advertises its own set rather than sharing a global enum.
   */
  efforts: readonly { value: string; label: string }[];
  supportsCompaction: boolean;
}

export type RuntimeModelSelection = {
  runtime: RuntimeId;
  model: string;
  /**
   * Reasoning/effort level for this role's sessions. Omitted / null means "no
   * override — use the runtime default", mirroring standalone sessions. Not a
   * pinned default like model (planner=opus, worker=sonnet) because effort has
   * no cost-tier convention worth forcing.
   */
  effort?: string | null;
};

const DEFAULT_PLANNER_MODEL_BY_RUNTIME: Record<RuntimeId, string> = {
  "claude-code": "claude-opus-4-8",
  codex: "gpt-5.6-sol",
};

const DEFAULT_WORKER_MODEL_BY_RUNTIME: Record<RuntimeId, string> = {
  "claude-code": "claude-sonnet-4-6",
  codex: "gpt-5.6-luna",
};

export function defaultPlannerModelForRuntime(runtimeId: RuntimeId): string {
  return DEFAULT_PLANNER_MODEL_BY_RUNTIME[runtimeId];
}

export function defaultWorkerModelForRuntime(runtimeId: RuntimeId): string {
  return DEFAULT_WORKER_MODEL_BY_RUNTIME[runtimeId];
}

/** Minimal shape `isAllowedModelForRuntime` needs from a runtime descriptor
 * lookup — narrower than the old AgentRuntime contract, since it needs
 * nothing beyond the descriptor and an optional adapter-native validator. */
export interface RuntimeDescriptorLookup {
  descriptor: RuntimeDescriptor;
  isAllowedModel?(model: string): boolean;
}

export function isAllowedModelForRuntime(
  runtime: RuntimeDescriptorLookup | undefined,
  model: string,
): boolean {
  const trimmedModel = model.trim();
  if (runtime?.isAllowedModel) return runtime.isAllowedModel(trimmedModel);
  const declaredModels = runtime?.descriptor.models ?? [];
  if (declaredModels.length > 0) {
    return declaredModels.some((m) => m.value === trimmedModel);
  }
  return trimmedModel.length > 0;
}
