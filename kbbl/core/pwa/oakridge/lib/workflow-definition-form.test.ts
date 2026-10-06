import { describe, expect, it } from "vitest";
import { validateWorkflowDefinition, workflowDefinitionToFormState } from "./workflow-definition-form";
import canonicalDefinition from "../../../../../workflow-config/definitions/development.json";
import minimalDefinition from "../../../../../workflow-core/fixtures/bundles/minimal.json";
import childDefinition from "../../../../../workflow-core/fixtures/bundles/children-1.json";
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
  it.each([minimalDefinition, childDefinition])("accepts alternate generic source shapes and omitted optional fields", (definition) => {
    expect(validateWorkflowDefinition(JSON.stringify(definition))).toEqual({ ok: true, value: definition });
  });
  it("rejects malformed nested source nodes before submission", () => {
    const definition = structuredClone(minimalDefinition);
    Object.assign(definition.scopes[0]?.tree, { value: { kind: "reference", root: { kind: "made_up" }, path: [] } });
    expect(validateWorkflowDefinition(JSON.stringify(definition)).ok).toBe(false);
  });
  it("rejects malformed nested schema fields before submission", () => {
    const definition = structuredClone(minimalDefinition);
    Object.assign(definition.schemas[0]?.shape, { fields: [{ key: "invalid" }] });
    expect(validateWorkflowDefinition(JSON.stringify(definition)).ok).toBe(false);
  });
  it("clones immutable content into the next definition version", () => {
    const parsed = validateWorkflowDefinition(JSON.stringify(canonicalDefinition));
    if (!parsed.ok) throw new Error("invalid fixture");
    const record: WorkflowDefFull = { id: "definition", name: parsed.value.key, version: parsed.value.version,
      definition: parsed.value, archived: false, created_at: "2026-10-03T00:00:00Z" };
    expect(JSON.parse(workflowDefinitionToFormState(record))).toEqual({ ...parsed.value, version: parsed.value.version + 1 });
  });
});
