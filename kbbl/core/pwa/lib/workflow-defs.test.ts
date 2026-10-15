import { describe, expect, it } from "vitest";

import type { WorkflowDefSummary } from "../oakridge/types";
import {
  defaultWorkflowDefinitionId,
  sortWorkflowDefinitions,
} from "./workflow-defs";

describe("workflow definition selectors", () => {
  it("selects the newest definition without filtering fan-out graphs", () => {
    const definitions: WorkflowDefSummary[] = [
      { id: "v1", name: "dev-flow", version: 1 },
      {
        id: "v2",
        name: "dev-flow",
        version: 2,
        graph: {
          stages: {
            build: {
              stage_type: "delegated_session",
              config: {
                runtime: "codex",
                prompt_template_path: "build.md",
                slot_bindings: {},
                workdir: { from: "literal", value: "/tmp" },
                session_name: "build",
                fan_out: {
                  over: { from: "literal", value: "[]" },
                  unit_id_path: "/id",
                },
              },
              inputs: [],
              outputs: [],
            },
          },
          edges: [],
        },
      },
    ];

    const sorted = sortWorkflowDefinitions(definitions);

    expect(sorted.map((definition) => definition.id)).toEqual(["v2", "v1"]);
    expect(defaultWorkflowDefinitionId(sorted)).toBe("v2");
  });
});
