import { expect, test } from "bun:test";

import { selectReadyUnits } from "../src/compiler/materialize-units";
import type { MaterializedExecutionUnit } from "../src/domain/compiled-workflow";
import type { UnitId } from "../src/domain/primitives";
import { isAwaitingReplacementOf, isLiveExecution, isStageDrained, selectLaunchedUnits, selectReleasedUnits, selectRunningUnitCount, type UnitRuntime } from "../src/workflows/unit-runtime";

const unit = (id: string, depends_on: readonly string[] = []): MaterializedExecutionUnit =>
  ({ unit_id: id as UnitId, parameters: { id }, depends_on: depends_on as readonly UnitId[] });
const units = [unit("a"), unit("b"), unit("c")];
const admitted = new Set(units.map((candidate) => candidate.unit_id));

const runtimeOf = (entries: readonly (readonly [string, UnitRuntime])[]): Map<UnitId, UnitRuntime> =>
  new Map(entries.map(([id, state]) => [id as UnitId, state]));

const window = (runtime: Map<UnitId, UnitRuntime>, max_parallel: number) => ({
  released: selectReleasedUnits(runtime), admitted, launched: selectLaunchedUnits(runtime),
  running_count: selectRunningUnitCount(runtime), max_parallel,
});

test("the window refills as each unit lands rather than after the whole batch drains", () => {
  const runtime = runtimeOf([]);
  expect(selectReadyUnits(units, window(runtime, 2)).map((candidate) => String(candidate.unit_id))).toEqual(["a", "b"]);
  runtime.set("a" as UnitId, { kind: "running", execution_workflow_id: "execution-a" });
  runtime.set("b" as UnitId, { kind: "running", execution_workflow_id: "execution-b" });
  expect(selectReadyUnits(units, window(runtime, 2))).toEqual([]);

  // The batch scheduler this replaces would leave 'c' waiting on 'b' as well,
  // because it only reconsidered launches once every started unit had finished.
  runtime.set("a" as UnitId, { kind: "released" });
  expect(selectReadyUnits(units, window(runtime, 2)).map((candidate) => String(candidate.unit_id))).toEqual(["c"]);
});

test("a unit parked for rerun frees its slot without being started again", () => {
  const runtime = runtimeOf([["a", { kind: "awaiting_rerun", execution_workflow_id: "execution-a" }], ["b", { kind: "running", execution_workflow_id: "execution-b" }]]);
  expect(selectReadyUnits(units, window(runtime, 2)).map((candidate) => String(candidate.unit_id))).toEqual(["c"]);
});

test("a dependent unit waits for its dependency to be released, not merely to be launched", () => {
  const dependents = [unit("a"), unit("b", ["a"])];
  const runtime = runtimeOf([["a", { kind: "running", execution_workflow_id: "execution-a" }]]);
  const admittedDependents = new Set(dependents.map((candidate) => candidate.unit_id));
  expect(selectReadyUnits(dependents, { ...window(runtime, 4), admitted: admittedDependents })).toEqual([]);
  runtime.set("a" as UnitId, { kind: "released" });
  expect(selectReadyUnits(dependents, { ...window(runtime, 4), admitted: admittedDependents }).map((candidate) => String(candidate.unit_id))).toEqual(["b"]);
});

test("a completion signal for a superseded execution is not the one the unit is on", () => {
  const runtime = runtimeOf([["a", { kind: "running", execution_workflow_id: "rerun-a" }]]);
  expect(isLiveExecution(runtime, "a" as UnitId, "rerun-a")).toBe(true);
  expect(isLiveExecution(runtime, "a" as UnitId, "execution-a")).toBe(false);
});

test("a completion signal redelivered after release finds nothing live to settle", () => {
  const runtime = runtimeOf([["a", { kind: "released" }]]);
  expect(isLiveExecution(runtime, "a" as UnitId, "execution-a")).toBe(false);
});

test("a rerun is accepted only against the exact failed execution the unit is parked on", () => {
  const runtime = runtimeOf([["a", { kind: "awaiting_rerun", execution_workflow_id: "execution-a" }], ["b", { kind: "running", execution_workflow_id: "execution-b" }]]);
  expect(isAwaitingReplacementOf(runtime, "a" as UnitId, "execution-a")).toBe(true);
  expect(isAwaitingReplacementOf(runtime, "a" as UnitId, "execution-a-stale")).toBe(false);
  expect(isAwaitingReplacementOf(runtime, "b" as UnitId, "execution-b")).toBe(false);
  expect(isAwaitingReplacementOf(runtime, "c" as UnitId, "execution-c")).toBe(false);
});

test("a stage drains only once no further units can arrive and every one is released", () => {
  const partial = runtimeOf([["a", { kind: "released" }], ["b", { kind: "running", execution_workflow_id: "execution-b" }]]);
  expect(isStageDrained(partial, 2, true)).toBe(false);
  const parked = runtimeOf([["a", { kind: "released" }], ["b", { kind: "awaiting_rerun", execution_workflow_id: "execution-b" }]]);
  expect(isStageDrained(parked, 2, true)).toBe(false);
  const done = runtimeOf([["a", { kind: "released" }], ["b", { kind: "released" }]]);
  expect(isStageDrained(done, 2, false)).toBe(false);
  expect(isStageDrained(done, 2, true)).toBe(true);
});

test("an incremental stage with no units yet is not drained until its inputs close", () => {
  expect(isStageDrained(runtimeOf([]), 0, false)).toBe(false);
  expect(isStageDrained(runtimeOf([]), 0, true)).toBe(true);
});
