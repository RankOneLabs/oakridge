import { describe, expect, it } from "vitest";
import { validateWorkflowDefinition, workflowDefinitionToFormState } from "./workflow-definition-form";
import canonicalDefinition from "../../../../../workflow-config/definitions/development.json";
import type { WorkflowDefFull } from "../types";

describe("canonical workflow authoring", () => {
  it("reports invalid JSON before submission", () => {
    expect(validateWorkflowDefinition("{").ok).toBe(false);
  });
  it("rejects retired graph and fan-out configuration", () => {
    expect(validateWorkflowDefinition(JSON.stringify({ name: "workflow", version: 1, graph: { stages: {}, edges: [] } })).ok).toBe(false);
  });
  it("validates every canonical worker and decision tree with the shared contract", () => {
    expect(validateWorkflowDefinition(JSON.stringify(canonicalDefinition))).toEqual({ ok: true, value: canonicalDefinition });
  });
  it("clones immutable content into the next definition version", () => {
    const parsed = validateWorkflowDefinition(JSON.stringify(canonicalDefinition));
    if (!parsed.ok) throw new Error("invalid fixture");
    const record: WorkflowDefFull = { id: "definition", name: parsed.value.key, version: parsed.value.version,
      definition: parsed.value, archived: false, created_at: "2026-10-03T00:00:00Z" };
    expect(JSON.parse(workflowDefinitionToFormState(record))).toEqual({ ...parsed.value, version: parsed.value.version + 1 });
  });
});
