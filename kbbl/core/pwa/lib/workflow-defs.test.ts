import { describe, expect, it } from "vitest";

import type { WorkflowDefDescriptor } from "./workflow-defs";
import {
  defaultWorkflowDefinitionId,
  sortWorkflowDefinitions,
} from "./workflow-defs";

describe("workflow definition selectors", () => {
  it("selects the newest definition by immutable version", () => {
    const definitions: WorkflowDefDescriptor[] = [
      { id: "def-a", name: "development", version: 1 },
      { id: "def-b", name: "development", version: 2 },
    ];

    const sorted = sortWorkflowDefinitions(definitions);

    expect(sorted.map((definition) => definition.id)).toEqual(["def-b", "def-a"]);
    expect(defaultWorkflowDefinitionId(sorted)).toBe("def-b");
  });
});
