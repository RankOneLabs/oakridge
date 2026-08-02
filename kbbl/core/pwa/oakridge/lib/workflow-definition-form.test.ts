import { describe, expect, it } from "vitest";
import { validateWorkflowDefinition } from "./workflow-definition-form";

describe("validateWorkflowDefinition", () => {
  it("returns contextual validation errors", () => {
    const result = validateWorkflowDefinition({ name: "", stages: [], edges: [] });

    expect(result).toEqual({
      ok: false,
      error: {
        operation: "validate_workflow_definition",
        entityId: "new_workflow_definition",
        details: ["Name is required."],
      },
    });
  });

  it("returns success for a valid empty graph", () => {
    expect(validateWorkflowDefinition({ name: "workflow", stages: [], edges: [] })).toEqual({
      ok: true,
      value: null,
    });
  });
});
