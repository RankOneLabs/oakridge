import { expect, test } from "bun:test";
import { sessionLostInTransport } from "../src/adapters/dev-flow-machine";
import { compileWorkflowDefinition } from "../src/compiler/compile-workflow";
import { transition } from "../src/decision/stage-machine";
import type { AttemptId, JsonValue } from "../src/domain/primitives";
import type { CompiledMachine, GuardContext, StageEvent, StateName, Transition } from "../src/domain/stage-machine";
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

const sessionEnded = (code: string): StageEvent => ({
  kind: "session_ended", attempt_id: "attempt-1" as AttemptId,
  outcome: { kind: "failed", code, detail: `session failed: ${code}` },
});

const guardArgs = { codes: ["acp_transport_lost"], max_relaunches: 2 };

const lostInTransport = (event: StageEvent, stage_data: JsonValue): boolean =>
  sessionLostInTransport({ event, stage_data, round_outputs: [], stage_inputs: {},
    registry: machineRegistry() } as unknown as GuardContext, guardArgs);

test("a transport-lost session is relaunched, a badly-finished one is not", () => {
  expect(lostInTransport(sessionEnded("acp_transport_lost"), {})).toBe(true);
  // An agent that ran and exited badly owns its outcome: that is the
  // operator's retry, not a free relaunch.
  expect(lostInTransport(sessionEnded("acp_prompt_failed"), {})).toBe(false);
  expect(lostInTransport(sessionEnded("requested_model_unsupported"), {})).toBe(false);
  // A kbbl restart is not a lost attempt. The session survives it and is
  // re-attached by lazy respawn on the next prompt, so relaunching would
  // spend a second attempt on work the first one still holds — which is
  // what the S14 acceptance scenario pins.
  expect(lostInTransport(sessionEnded("kbbl_restart"), {})).toBe(false);
});

test("only a failed session end can be a transport loss", () => {
  expect(lostInTransport({ kind: "session_ended", attempt_id: "attempt-1" as AttemptId,
    outcome: { kind: "exited", exit_code: 0 } }, {})).toBe(false);
  expect(lostInTransport({ kind: "started" }, {})).toBe(false);
});

test("the relaunch cap stops a cohort respawning against a broken executor", () => {
  const event = sessionEnded("acp_transport_lost");
  expect(lostInTransport(event, { session_relaunches: 1 })).toBe(true);
  expect(lostInTransport(event, { session_relaunches: 2 })).toBe(false);
  expect(lostInTransport(event, { session_relaunches: 7 })).toBe(false);
});

test("both build roles relaunch on transport loss ahead of parking as lost", () => {
  const build = machines.build_cohort as unknown as CompiledMachine | undefined;
  if (!build) throw new Error("build_cohort machine is missing");
  const pairs: readonly (readonly [StateName, StateName])[] = [
    ["building", "build_lost"], ["assessing", "assess_lost"],
  ] as unknown as readonly (readonly [StateName, StateName])[];
  for (const [from, parked] of pairs) {
    const rows = build.transitions.filter((row) => row.from === from && row.on.event === "session_ended");
    const guarded = rows.findIndex((row) => row.guard?.name === "session_lost_in_transport");
    const unguarded = rows.findIndex((row) => row.guard === null);
    expect(guarded).toBeGreaterThanOrEqual(0);
    // First match wins, so the guarded relaunch must precede the fallback.
    expect(guarded).toBeLessThan(unguarded);
    expect("to" in rows[unguarded]! ? rows[unguarded]!.to : null).toBe(parked);
  }
});
