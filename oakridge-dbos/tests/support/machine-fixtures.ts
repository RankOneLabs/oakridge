import type { WorkflowDefinition } from "../../src/domain/workflow";
import type { MachineDefinition, GuardContext, StageEvent, Transition } from "../../src/domain/stage-machine";
import { StageMachineRegistry } from "../../src/runtime/executor-registry";
import { loadGraphDefinitionFixture as loadDevFlowV15 } from "./graph-definition-fixture";
import { registerDevFlowMachine } from "../../src/adapters/dev-flow-machine";

export const machineRegistry = (): StageMachineRegistry => {
  const registry = new StageMachineRegistry();
  registerDevFlowMachine(registry, new Map());
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
    machines: { ...definition.machines, spec_review: reviewMachine() },
    graph: { ...definition.graph, stages: { ...definition.graph.stages,
      spec_analyzer: { ...stage, config: { ...(stage.config as object), machine: "spec_review" } } } },
  };
};

export const eventForRow = (row: Transition): StageEvent => {
  switch (row.on.event) {
    case "started": return { kind: "started" };
    case "artifact_published": return { kind: "artifact_published", output: row.on.output,
      attempt_id: "attempt" as never, artifact_id: "artifact" as never,
      collection_key: row.on.output === "brief" ? "b" : null,
      enrichment: row.on.output === "pr_summary"
        ? { pr: { owner: "RankOneLabs", name: "oakridge", state: "open", number: 1, base_branch: "main", head_branch: "cohort-a",
          head_sha: "head" }, expected_repository: { owner: "RankOneLabs", name: "oakridge" }, expected_pr_base: "main", canonical_ref: "cohort-a",
          origin_head_sha: "head" } : null };
    case "gate_decided": return { kind: "gate_decided", gate_id: "gate" as never,
      gate: row.on.gate, action: row.on.action, actor: "operator", feedback: null };
    case "session_ended": return { kind: "session_ended", attempt_id: "attempt" as never,
      outcome: { kind: "exited", exit_code: 0 } };
    case "operator_retry": return { kind: "operator_retry", idempotency_key: "retry", actor: "operator" };
    case "operator_abandon": return { kind: "operator_abandon", actor: "operator", detail: "stop" };
    case "cancel": return { kind: "cancel", actor: "operator" };
    case "external_observed": return { kind: "external_observed", source: row.on.source,
      observation: { state: "open", merged_at: null, base_branch: "main" } };
  }
};

export const contextForMachineRow = (machine_name: string, index: number, row: Transition): GuardContext => {
  let event = eventForRow(row);
  let round_outputs: GuardContext["round_outputs"] = [];
  let stage_inputs: GuardContext["stage_inputs"] = {};
  const stage_data: GuardContext["stage_data"] = { expected_pr_base: "main" };
  if (machine_name === "brief_review" && row.on.event === "artifact_published" && row.from === "working") {
    stage_inputs = { plan: { body: { cohorts: [{ id: "a" }, { id: "b" }] } } as never };
    if (index >= 2) round_outputs = [{ output: "brief", collection_key: "a", artifact_id: "a" as never,
      body: index === 2 ? { depends_on: ["b"] } : { depends_on: [] } }];
    if (index === 2) event = { ...event, enrichment: { artifact_body: { depends_on: ["a"] } } } as StageEvent;
  }
  if (machine_name === "build_cohort") {
    if (index === 1 && event.kind === "artifact_published") {
      event = { ...event, enrichment: { pr: { owner: "RankOneLabs", name: "oakridge", state: "open", number: 1, base_branch: "wrong",
        head_branch: "cohort-a", head_sha: "head" }, expected_repository: { owner: "RankOneLabs", name: "oakridge" }, expected_pr_base: "main",
        canonical_ref: "cohort-a", origin_head_sha: "head" } };
    }
    if ((index === 3 || index === 5) && event.kind === "artifact_published")
      round_outputs = [{ output: index === 3 ? "build_result" : "pr_summary",
        collection_key: null, artifact_id: "prior" as never, body: {} }];
    if (event.kind === "artifact_published" && event.output === "pr_summary")
      round_outputs = [...round_outputs, { output: "pr_summary", collection_key: null,
        artifact_id: event.artifact_id, body: { branch: "cohort-a", base_branch: "main" } }];
    if (event.kind === "external_observed") {
      event = { ...event, observation: index === 15 || index === 18
        ? { state: "merged", merged_at: "2026-01-01T00:00:00Z", base_branch: "main" }
        : index === 16 || index === 19
          ? { state: "closed_unmerged", merged_at: null, base_branch: "main" }
          : { state: "open", merged_at: null, base_branch: "main" } };
    }
  }
  return { event, stage_data, round_outputs, stage_inputs, registry: machineRegistry() };
};
