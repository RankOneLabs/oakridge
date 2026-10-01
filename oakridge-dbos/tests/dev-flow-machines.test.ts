import { expect, test } from "bun:test";
import { compileWorkflowDefinition } from "../src/compiler/compile-workflow";
import { transition } from "../src/decision/stage-machine";
import type { CompiledMachine, StateName, Transition } from "../src/domain/stage-machine";
import { loadDevFlowV15 } from "../src/seed/dev-flow-v15";
import { contextForMachineRow, machineRegistry } from "./support/machine-fixtures";

const loaded = await loadDevFlowV15();
if (!loaded.ok) throw new Error(loaded.error.detail);
const definition = loaded.value;
const machines = definition.machines ?? {};

const sameGroup = (machine: CompiledMachine, earlier: Transition, current: Transition, from: StateName): boolean => {
  const fromMatches = typeof earlier.from === "string" ? earlier.from === from
    : !["complete", "failed", "cancelled"].includes(machine.states[from]?.status ?? "failed");
  return fromMatches && JSON.stringify(earlier.on) === JSON.stringify(current.on);
};

test("the real dev-flow v15 definition validates with registered machines", () => {
  const compiled = compileWorkflowDefinition(definition, undefined, undefined, machineRegistry());
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) throw new Error(compiled.error.detail);
  expect(Object.values(compiled.value.stages).every((stage) => stage.machine !== undefined)).toBe(true);
});

for (const [machine_name, machine] of Object.entries(machines)) {
  for (const [index, row] of machine.transitions.entries()) {
    test(`${machine_name} row ${index} selects its declared outcome and effects`, () => {
      const context = contextForMachineRow(machine_name, index, row);
      const from = (typeof row.from === "string" ? row.from
        : row.on.event === "artifact_published" ? "build_lost" : machine.initial) as StateName;
      const result = transition({ ...machine, stage_type: "delegated_session" } as CompiledMachine,
        from, context.event, context);
      for (const earlier of machine.transitions.slice(0, index)) {
        if (!sameGroup({ ...machine, stage_type: "delegated_session" } as CompiledMachine, earlier, row, from)) continue;
        expect(earlier.guard).not.toBeNull();
        if (!earlier.guard) continue;
        const predicate = context.registry.guard("delegated_session", earlier.guard.name);
        expect(predicate).toBeDefined();
        if (!predicate) continue;
        const outcome = predicate(context, earlier.guard.args);
        const holds = typeof outcome === "boolean" ? outcome : outcome.holds;
        expect(earlier.guard.negate ? !holds : holds).toBe(false);
      }
      expect(result.row_index).toBe(index);
      if ("to" in row) expect(result).toMatchObject({ kind: "applied", to: row.to, effects: row.effects });
      else expect(result).toMatchObject({ kind: "refused", code: row.refuse });
    });
  }

  test(`${machine_name} paths reach a terminal or operator state`, () => {
    const states = machine.states;
    const exercised = new Set<number>();
    const enumerate = (state: string, visited: Set<string>): boolean => {
      const declaration = states[state as StateName];
      if (!declaration) return false;
      if (["complete", "failed", "cancelled"].includes(declaration.status) || declaration.next_actor === "operator")
        return true;
      if (visited.has(state)) return false;
      const next = new Set(visited);
      next.add(state);
      const exits = machine.transitions.flatMap((row: Transition, index) => "to" in row
        && !next.has(row.to)
        && (typeof row.from === "string" ? row.from === state : declaration.status !== "complete")
        ? [{ row, index }] : []);
      for (const exit of exits) exercised.add(exit.index);
      return exits.length > 0 && exits.every(({ row }) => "to" in row && enumerate(row.to, next));
    };
    expect(enumerate(machine.initial, new Set())).toBe(true);
    expect(exercised.size).toBeGreaterThan(0);
  });
}
