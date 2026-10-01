import { expect, test } from "bun:test";
import { compileWorkflowDefinition, type MachineCheck, type MachineDiagnostic } from "../src/compiler/compile-workflow";
import type { WorkflowDefinition } from "../src/domain/workflow";
import { parseStageContractMachine } from "../src/domain/stage-contract";
import { definitionWithMachine, machineRegistry } from "./support/machine-fixtures";

type MutableDefinition = Record<string, any>;

const diagnosticsFor = (definition: WorkflowDefinition): readonly MachineDiagnostic[] => {
  const result = compileWorkflowDefinition(definition, undefined, undefined, machineRegistry());
  return result.ok ? [] : (result.error.diagnostics ?? []).filter((diagnostic): diagnostic is MachineDiagnostic => diagnostic.kind === "machine_validation");
};

const mutate = async (change: (definition: MutableDefinition) => void): Promise<readonly MachineDiagnostic[]> => {
  const definition = structuredClone(await definitionWithMachine()) as unknown as MutableDefinition;
  change(definition);
  return diagnosticsFor(definition as unknown as WorkflowDefinition);
};

test("a valid machine pins its ordered transitions into the stage contract", async () => {
  const definition = await definitionWithMachine();
  const result = compileWorkflowDefinition(definition, undefined, undefined, machineRegistry());
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.stages.spec_analyzer?.machine?.transitions).toEqual(definition.machines?.spec_review?.transitions);
  expect(result.value.stages.spec_analyzer?.machine?.stage_type).toBe("delegated_session");
  expect(JSON.parse(JSON.stringify(result.value.stages.spec_analyzer))?.machine?.transitions).toEqual(definition.machines?.spec_review?.transitions);
  expect(parseStageContractMachine(JSON.parse(JSON.stringify(result.value.stages.spec_analyzer)))?.transitions).toEqual(definition.machines?.spec_review?.transitions);
});

test("a malformed pinned machine is rejected at the JSON boundary", async () => {
  const definition = await definitionWithMachine();
  const result = compileWorkflowDefinition(definition, undefined, undefined, machineRegistry());
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const contract = structuredClone(result.value.stages.spec_analyzer) as Record<string, any>;
  contract.machine.transitions = [null];
  expect(parseStageContractMachine(contract)).toBeNull();
  contract.machine.transitions = definition.machines?.spec_review?.transitions;
  contract.machine.states.pending.status = "invalid";
  expect(parseStageContractMachine(contract)).toBeNull();
});

test("guard, effect and observer names resolve through the stage registry", async () => {
  const diagnostics = await mutate((definition) => {
    definition.machines.spec_review.transitions[0].guard = { name: "unknown_guard", negate: false, args: {} };
    definition.machines.spec_review.transitions[0].effects[0].name = "unknown_effect";
    definition.machines.spec_review.transitions.push({ from: "working", on: { event: "external_observed", source: "unknown_observer" }, guard: null, refuse: "ignored" });
  });
  expect(diagnostics.filter((item) => item.check === "names_exist").map((item) => item.detail)).toEqual(expect.arrayContaining([
    "guard 'unknown_guard' is unregistered", "effect 'unknown_effect' is unregistered", "observer 'unknown_observer' is unregistered",
  ]));
});

const cases: readonly { name: MachineCheck; change: (definition: MutableDefinition) => void; state: string | null; row_index: number | null }[] = [
  { name: "names_exist", change: (definition) => { definition.machines.spec_review.transitions[0].to = "missing"; }, state: "missing", row_index: 0 },
  { name: "initial_state", change: (definition) => { definition.machines.spec_review.transitions[0].to = "pending"; }, state: "pending", row_index: 0 },
  { name: "reachability", change: (definition) => { definition.machines.spec_review.states.island = { status: "complete", blocked_reason: null, next_actor: null, session_role: null }; }, state: "island", row_index: null },
  { name: "group_totality", change: (definition) => { definition.machines.spec_review.transitions[0].guard = { name: "allow", negate: false, args: {} }; }, state: "pending", row_index: 0 },
  { name: "mandatory_events", change: (definition) => { definition.machines.spec_review.transitions.pop(); }, state: "pending", row_index: null },
  { name: "termination", change: (definition) => {
    definition.machines.spec_review.states.stuck = { status: "active", blocked_reason: null, next_actor: "core", session_role: null };
    definition.machines.spec_review.transitions[7].from = "pending";
    definition.machines.spec_review.transitions[8].from = "pending";
    definition.machines.spec_review.transitions.push({ from: "stuck", on: { event: "started" }, guard: null, to: "stuck", effects: [] });
  }, state: "stuck", row_index: null },
  { name: "prompt_totality", change: (definition) => { definition.machines.spec_review.transitions[0].effects[0].args.reason = "unknown"; }, state: "working", row_index: 0 },
  { name: "retry_correspondence", change: (definition) => { definition.machines.spec_review.transitions.splice(6, 1); }, state: "lost", row_index: null },
  { name: "outputs", change: (definition) => { definition.machines.spec_review.transitions[1].effects[0].name = "new_round"; definition.machines.spec_review.transitions[1].on = { event: "started" }; }, state: null, row_index: null },
  { name: "gates", change: (definition) => { definition.machines.spec_review.transitions[1].effects[1].args.gate = "missing_gate"; }, state: "review", row_index: 1 },
  { name: "no_orphan_gate", change: (definition) => { definition.machines.spec_review.transitions.push({ from: "review", on: { event: "started" }, guard: null, to: "working", effects: [] }); }, state: "review", row_index: 9 },
];

for (const scenario of cases) test(`${scenario.name} reports stage, state and row index`, async () => {
  const diagnostic = (await mutate(scenario.change)).find((item) => item.check === scenario.name && item.state === scenario.state && item.row_index === scenario.row_index);
  expect(diagnostic).toMatchObject({ kind: "machine_validation", check: scenario.name, stage_key: "spec_analyzer", state: scenario.state, row_index: scenario.row_index });
});

test("multi-step gate actions are all required", async () => {
  const diagnostics = await mutate((definition) => {
    definition.graph.stages.spec_analyzer.config.gates[0].steps.push({ type: "merge_confirmation", actions: ["confirm_merged"] });
  });
  expect(diagnostics).toContainEqual(expect.objectContaining({ check: "mandatory_events", stage_key: "spec_analyzer", state: "review", row_index: 1,
    detail: "missing gate_decided spec_analysis_gate:confirm_merged" }));
});

test("launch role must match the state it enters", async () => {
  const diagnostics = await mutate((definition) => { definition.machines.spec_review.transitions[0].effects[0].args.role = "other"; });
  expect(diagnostics).toContainEqual(expect.objectContaining({ check: "prompt_totality", stage_key: "spec_analyzer", state: "working", row_index: 0,
    detail: "launch role 'other' does not match target" }));
});

test("a session state needs an entering launch, excluding same-role self-loops", async () => {
  const diagnostics = await mutate((definition) => {
    definition.machines.spec_review.transitions[0].effects = [];
    definition.machines.spec_review.transitions[4].effects = [];
    definition.machines.spec_review.transitions[6].effects = [];
    definition.machines.spec_review.transitions.push({ from: "working", on: { event: "started" }, guard: null, to: "working", effects: [{ name: "launch_session", args: { role: "spec", reason: "initial" } }] });
  });
  expect(diagnostics).toContainEqual(expect.objectContaining({ check: "prompt_totality", stage_key: "spec_analyzer", state: "working", row_index: null,
    detail: "session state 'working' has no entering launch" }));
});
