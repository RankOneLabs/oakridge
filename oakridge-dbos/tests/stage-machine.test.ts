import { expect, test } from "bun:test";
import { transition } from "../src/decision/stage-machine";
import type { CompiledMachine, GuardContext, StageEvent, Transition } from "../src/domain/stage-machine";
import { machineRegistry, reviewMachine } from "./support/machine-fixtures";

const started: StageEvent = { kind: "started" };
const registry = machineRegistry();
const context = (event: StageEvent): GuardContext => ({ event, stage_data: {}, round_outputs: [], stage_inputs: {}, registry });
const machine = (rows: readonly Transition[]): CompiledMachine => ({ ...reviewMachine(), stage_type: "delegated_session", transitions: rows });

test("an unlisted event pair refuses without a row", () => {
  expect(transition(machine([]), "pending" as never, started, context(started))).toMatchObject({ kind: "refused", code: "no_transition", row_index: null });
});

test("first matching row wins and preserves effects in declaration order", () => {
  const rows = reviewMachine().transitions;
  const first = rows[0]!;
  const effects = [{ name: "record_output", args: {} }, { name: "end_session", args: {} }];
  const second = { ...first, to: "done", effects } as unknown as Transition;
  expect(transition(machine([second, first]), "pending" as never, started, context(started))).toMatchObject({ kind: "applied", to: "done", row_index: 0, effects });
});

test("a negated guard skips the first row when the predicate holds", () => {
  const first = { ...reviewMachine().transitions[0]!, guard: { name: "allow", negate: true, args: {} } } as Transition;
  const result = transition(machine([first, reviewMachine().transitions[0]!]), "pending" as never, started, context(started));
  expect(result).toMatchObject({ kind: "applied", row_index: 1 });
});

test("a missing negated guard cannot authorize a transition", () => {
  const row = { ...reviewMachine().transitions[0]!, guard: { name: "missing", negate: true, args: {} } } as Transition;
  expect(transition(machine([row]), "pending" as never, started, context(started))).toMatchObject({ kind: "refused", code: "no_transition", row_index: null });
});

test("guards see the event being transitioned rather than a stale context event", () => {
  const event: StageEvent = { kind: "cancel", actor: "current" };
  const stale: StageEvent = { kind: "cancel", actor: "stale" };
  const guardedRegistry = machineRegistry();
  guardedRegistry.register_guard("delegated_session", "current_actor" as never, (guardContext) =>
    guardContext.event.kind === "cancel" && guardContext.event.actor === "current");
  const row = { ...reviewMachine().transitions.at(-1)!, guard: { name: "current_actor", negate: false, args: {} } } as Transition;
  expect(transition(machine([row]), "pending" as never, event, { ...context(stale), registry: guardedRegistry })).toMatchObject({ kind: "applied", row_index: 0 });
});

test("any_nonterminal matches pending but not complete", () => {
  const event: StageEvent = { kind: "cancel", actor: "operator" };
  const row = reviewMachine().transitions.at(-1)!;
  expect(transition(machine([row]), "pending" as never, event, context(event)).kind).toBe("applied");
  expect(transition(machine([row]), "done" as never, event, context(event))).toMatchObject({ kind: "refused", code: "no_transition" });
});

test("a refusal row returns its code", () => {
  const row = { from: "pending", on: { event: "started" }, guard: null, refuse: "not_ready" } as Transition;
  expect(transition(machine([row]), "pending" as never, started, context(started))).toMatchObject({ kind: "refused", code: "not_ready", row_index: 0 });
});
