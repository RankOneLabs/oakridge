import type { WorkflowDefinition } from "../../src/domain/workflow";
import type { MachineDefinition } from "../../src/domain/stage-machine";
import { StageMachineRegistry } from "../../src/runtime/executor-registry";
import { loadDevFlowV15 } from "../../src/seed/dev-flow-v15";

export const machineRegistry = (): StageMachineRegistry => {
  const registry = new StageMachineRegistry();
  for (const name of ["launch_session", "record_output", "open_gate", "accept_outputs", "end_session", "new_round"])
    registry.register_effect("delegated_session", name as never);
  registry.register_guard("delegated_session", "allow" as never, () => true);
  registry.register_observer("delegated_session", "watcher" as never);
  return registry;
};

export const reviewMachine = (): MachineDefinition => ({
  initial: "pending",
  states: {
    pending: { status: "pending", blocked_reason: null, next_actor: "core", session_role: null },
    working: { status: "active", blocked_reason: null, next_actor: "agent", session_role: "spec" },
    review: { status: "blocked", blocked_reason: "gate", next_actor: "operator", session_role: null },
    lost: { status: "blocked", blocked_reason: "retry", next_actor: "operator", session_role: null },
    done: { status: "complete", blocked_reason: null, next_actor: null, session_role: null },
    abandoned: { status: "failed", blocked_reason: null, next_actor: null, session_role: null },
    cancelled: { status: "cancelled", blocked_reason: null, next_actor: null, session_role: null },
  },
  transitions: [
    { from: "pending", on: { event: "started" }, guard: null, to: "working", effects: [{ name: "launch_session", args: { role: "spec", reason: "initial" } }] },
    { from: "working", on: { event: "artifact_published", output: "spec_analysis" }, guard: null, to: "review", effects: [
      { name: "record_output", args: {} }, { name: "open_gate", args: { gate: "spec_analysis_gate", outputs: ["spec_analysis"] } }] },
    { from: "working", on: { event: "session_ended" }, guard: null, to: "lost", effects: [] },
    { from: "review", on: { event: "gate_decided", gate: "spec_analysis_gate", action: "approve" }, guard: null, to: "done", effects: [{ name: "accept_outputs", args: { outputs: ["spec_analysis"] } }] },
    { from: "review", on: { event: "gate_decided", gate: "spec_analysis_gate", action: "request_revision" }, guard: null, to: "working", effects: [{ name: "new_round", args: {} }, { name: "launch_session", args: { role: "spec", reason: "input_revision" } }] },
    { from: "review", on: { event: "session_ended" }, guard: null, to: "review", effects: [] },
    { from: "lost", on: { event: "operator_retry" }, guard: null, to: "working", effects: [{ name: "launch_session", args: { role: "spec", reason: "operator_retry" } }] },
    { from: { any_nonterminal: true }, on: { event: "operator_abandon" }, guard: null, to: "abandoned", effects: [{ name: "end_session", args: {} }] },
    { from: { any_nonterminal: true }, on: { event: "cancel" }, guard: null, to: "cancelled", effects: [{ name: "end_session", args: {} }] },
  ],
} as unknown as MachineDefinition);

export const definitionWithMachine = async (): Promise<WorkflowDefinition> => {
  const loaded = await loadDevFlowV15();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const definition = structuredClone(loaded.value);
  const stage = definition.graph.stages.spec_analyzer!;
  return {
    ...definition,
    machines: { spec_review: reviewMachine() },
    graph: { ...definition.graph, stages: { ...definition.graph.stages,
      spec_analyzer: { ...stage, config: { ...(stage.config as object), machine: "spec_review" } } } },
  };
};
