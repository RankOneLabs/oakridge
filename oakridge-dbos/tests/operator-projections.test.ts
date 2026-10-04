import { expect, test } from "bun:test";
import { selectGateActionability, selectV15StageOrder } from "../src/domain/operator-projections";
import { loadDevFlowV15 } from "../src/seed/dev-flow-v15";

test("review actions stop when the run ends", () => {
  expect(["active", "blocked", "complete", "failed", "cancelled"].map((status) => selectGateActionability(status as never)))
    .toEqual([true, true, false, false, false]);
});
test("canonical stage order follows named prerequisites", async () => {
  const definition = await loadDevFlowV15();
  if (!definition.ok) throw new Error(definition.error.detail);
  expect(selectV15StageOrder(definition.value)).toEqual(["repository_preparation", "spec_analysis", "planning", "brief_writing", "implementation", "final_integration"]);
});
test("a cyclic stored contract cannot manufacture a pending order", async () => {
  const definition = await loadDevFlowV15();
  if (!definition.ok) throw new Error(definition.error.detail);
  definition.value.stages.repository_preparation.prerequisites = ["final_integration"];
  expect(() => selectV15StageOrder(definition.value)).toThrow("cycle");
});
