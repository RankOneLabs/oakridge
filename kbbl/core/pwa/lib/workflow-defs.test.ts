import { describe, expect, it } from "vitest";

import type { WorkflowDefDescriptor } from "./workflow-defs";
import {
  defaultWorkflowDefinitionId,
  sortWorkflowDefinitions,
} from "./workflow-defs";

describe("workflow definition selectors", () => {
  it("selects the newest definition by immutable version", () => {
    const definitions: WorkflowDefDescriptor[] = [
      { id: "v1", name: "dev-flow", version: 1 },
      { id: "v2", name: "dev-flow", version: 2 },
    ];

    const sorted = sortWorkflowDefinitions(definitions);

    expect(sorted.map((definition) => definition.id)).toEqual(["v2", "v1"]);
    expect(defaultWorkflowDefinitionId(sorted)).toBe("v2");
  });
});
