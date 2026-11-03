import { expect, it } from "vitest";
import { defaultWorkflowDefinitionId, sortWorkflowDefinitions } from "./workflow-defs";
it("sorts committed definitions by name and ID", () => {
  expect(sortWorkflowDefinitions([{ id: "b", name: "z" }, { id: "a", name: "a" }]).map((item) => item.id)).toEqual(["a", "b"]);
});
it("has no default when the catalog is empty", () => {
  expect(defaultWorkflowDefinitionId([])).toBeNull();
});
