import { describe, expect, test } from "vitest";
import { makeDefinitionSummary, makeWorkflowAuthoring } from "../__fixtures__/read-models";
import { selectCloneAuthoring, selectDefinitionSummary, selectStoredAuthoring } from "./workflow-definition-form";

describe("pinned workflow definition authoring", () => {
  test("rejects authoring details whose version the editor cannot understand", () => {
    expect(selectStoredAuthoring({ authoring: { ...makeWorkflowAuthoring(), authoring_version: 2 } })).toBeNull();
  });

  test("reads and clones valid stored authoring", () => {
    const authoring = makeWorkflowAuthoring({ key: "workflow" });
    expect(selectStoredAuthoring({ authoring })).toEqual(authoring);
    expect(selectCloneAuthoring(authoring).key).toBe("workflow-copy");
  });

  test("finds a pinned definition in the archived catalog when absent from active definitions", () => {
    const archived = makeDefinitionSummary({ bundle_id: "bundle-archive", archived_at: "2026-10-10T00:00:00Z" });
    expect(selectDefinitionSummary([], [archived], archived.bundle_id)).toEqual(archived);
  });
});
