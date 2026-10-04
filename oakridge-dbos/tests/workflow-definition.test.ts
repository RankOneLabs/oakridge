import { expect, test } from "bun:test";
import { parseV15WorkflowDefinition } from "../src/validation/v15-definition";
import { loadDevFlowV15 } from "../src/seed/dev-flow-v15";

test("the committed v15 definition parses without a role or machine registry", async () => {
  const loaded = await loadDevFlowV15();
  expect(loaded.ok).toBe(true);
});

test("the v15 parser refuses the retired executable graph contract", () => {
  expect(parseV15WorkflowDefinition({ id: "legacy", name: "flow", version: 1, graph: { stages: {}, edges: [] }, machines: {} }).ok).toBe(false);
});
