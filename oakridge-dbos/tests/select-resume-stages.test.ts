import { expect, test } from "bun:test";

import { compileWorkflowDefinition } from "../src/compiler/compile-workflow";
import { selectAncestorStages } from "../src/compiler/select-resume-stages";
import { loadDevFlowV11 } from "../src/seed/dev-flow-v11";

test("stage rerun inherits only graph ancestors and leaves the selected stage plus descendants to DBOS", async () => {
  const loaded = await loadDevFlowV11();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const compiled = compileWorkflowDefinition(loaded.value);
  if (!compiled.ok) throw new Error(compiled.error.detail);
  const ancestors = selectAncestorStages(compiled.value, "build");
  expect(ancestors).toContain("spec_analyzer");
  expect(ancestors).toContain("plan_writer");
  expect(ancestors).not.toContain("build");
  expect(ancestors).not.toContain("assess");
  expect(ancestors).not.toContain("final_integration");
});
