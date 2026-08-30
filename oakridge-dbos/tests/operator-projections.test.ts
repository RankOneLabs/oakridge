import { expect, test } from "bun:test";
import { selectGateActionability, selectPendingStageOrder } from "../src/domain/operator-projections";
import type { CompiledEdge, CompiledStageContract, CompiledWorkflowDefinition } from "../src/domain/compiled-workflow";
import type { StageKey } from "../src/domain/workflow";

const stage = (stage_key: string): CompiledStageContract => ({
  stage_key: stage_key as StageKey, stage_type: "delegated_session", operator_role: null,
  inputs: [], outputs: [], materialization: { kind: "scalar" },
  executor: { executor_type: "delegated_session", definition_config: {} },
});

const edge = (producer_stage: string, consumer_stage: string): CompiledEdge => ({
  producer_stage: producer_stage as StageKey, producer_output: "out", consumer_stage: consumer_stage as StageKey,
  consumer_input: "in", delivery: "producer_complete",
});

const definitionOf = (stage_keys: readonly string[], edges: readonly CompiledEdge[], source_stages: readonly string[]): CompiledWorkflowDefinition => ({
  stages: Object.fromEntries(stage_keys.map((key) => [key, stage(key)])),
  edges,
  source_stages: source_stages as readonly StageKey[],
});

test("a gate is actionable only while its run is active", () => {
  expect(selectGateActionability("active")).toBe(true);
  expect(selectGateActionability("succeeded")).toBe(false);
  expect(selectGateActionability("failed")).toBe(false);
  expect(selectGateActionability("cancelled")).toBe(false);
});

test("a linear chain of definition stages orders producer before consumer", () => {
  const definition = definitionOf(["a", "b", "c"], [edge("a", "b"), edge("b", "c")], ["a"]);
  expect(selectPendingStageOrder(definition, [])).toEqual(["a", "b", "c"]);
});

test("stages that already have a row are dropped without disturbing the order of the rest", () => {
  const definition = definitionOf(["a", "b", "c"], [edge("a", "b"), edge("b", "c")], ["a"]);
  expect(selectPendingStageOrder(definition, ["a"])).toEqual(["b", "c"]);
});

test("stages that become ready in the same round are ordered by stage_key", () => {
  // a -> b, a -> c, b -> d, c -> d: once "a" is processed, "b" and "c" tie.
  const definition = definitionOf(["a", "b", "c", "d"], [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")], ["a"]);
  expect(selectPendingStageOrder(definition, [])).toEqual(["a", "b", "c", "d"]);
});

test("a stage the compiler already marked as a source is ready in round one even with an incoming edge — an optional input, not a blocking one", () => {
  // "zeta" -> "alpha" is a real edge, but the compiler put "alpha" in
  // source_stages anyway (its input on that edge is optional, so it is not
  // blocked). Seeding round one from `source_stages` — not from raw
  // in-degree alone — is what lets "alpha" win the stage_key tie against its
  // own producer "zeta" here, rather than waiting for it.
  const definition = definitionOf(["alpha", "zeta"], [edge("zeta", "alpha")], ["alpha", "zeta"]);
  expect(selectPendingStageOrder(definition, [])).toEqual(["alpha", "zeta"]);
});

test("a cycle does not throw — every stage is still listed, in stage_key order for the unresolved remainder", () => {
  const definition = definitionOf(["x", "y"], [edge("x", "y"), edge("y", "x")], []);
  expect(selectPendingStageOrder(definition, [])).toEqual(["x", "y"]);
});

test("every definition stage already stored yields an empty pending order", () => {
  const definition = definitionOf(["a", "b"], [edge("a", "b")], ["a"]);
  expect(selectPendingStageOrder(definition, ["a", "b"])).toEqual([]);
});
