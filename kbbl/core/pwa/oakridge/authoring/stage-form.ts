import type { DelegatedSessionStageConfig, InputSlotDef, OutputSlotDef, StageNodeDef } from "../types";

export interface StageFormEntry {
  readonly _uid: string;
  stageKey: string;
  inputs: InputSlotDef[];
  outputs: OutputSlotDef[];
  config: DelegatedSessionStageConfig;
}

function defaultStageConfig(): DelegatedSessionStageConfig {
  return {
    runtime: "claude-code", prompt_template_path: "", slot_bindings: {},
    workdir: { from: "context", path: "/workdir" }, session_name: "",
    model: null, effort: null, worktree: null, pre_authorized_tools: [],
    yolo: false, fan_out: null, gate_output: null,
  };
}

export function defaultStageEntry(stageKey: string): StageFormEntry {
  return { _uid: crypto.randomUUID(), stageKey, inputs: [], outputs: [], config: defaultStageConfig() };
}

export function stageFormEntryToNodeDef(entry: StageFormEntry): StageNodeDef {
  const config = { ...entry.config };
  if (!config.model) delete config.model;
  if (!config.effort) delete config.effort;
  if (!config.worktree) delete config.worktree;
  if (!config.fan_out) delete config.fan_out;
  if (!config.gate_output) delete config.gate_output;
  if (!config.pre_authorized_tools?.length) delete config.pre_authorized_tools;
  return { stage_type: "delegated_session", config, inputs: entry.inputs, outputs: entry.outputs };
}
