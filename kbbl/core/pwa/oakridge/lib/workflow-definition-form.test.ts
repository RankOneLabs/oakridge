import { describe, expect, test } from "vitest";
import { makeDefinitionSummary, makeWorkflowSource } from "../__fixtures__/read-models";
import { formatWorkflowText, parseWorkflowText, selectCloneWorkflow, selectDefinitionSummary } from "./workflow-definition-form";

describe("workflow definition editing", () => {
  test("reads the editor's text back as the workflow it formats", () => {
    const workflow = makeWorkflowSource();
    expect(parseWorkflowText(formatWorkflowText(workflow))).toEqual({ ok: true, value: workflow });
  });

  test("refuses text that is not JSON, or JSON that is not a workflow", () => {
    expect([parseWorkflowText("{").ok, parseWorkflowText('{"workflow": "x"}').ok]).toEqual([false, false]);
  });

  test("renames a clone so pinning it leaves its source as it is", () => {
    expect(selectCloneWorkflow(makeWorkflowSource({ workflow: "development" })).workflow).toBe("development_copy");
  });

  test("finds a pinned definition in the archived catalog when absent from active definitions", () => {
    const archived = makeDefinitionSummary({ bundle_id: "bundle-archive", archived_at: "2026-10-10T00:00:00Z" });
    expect(selectDefinitionSummary([], [archived], archived.bundle_id)).toEqual(archived);
  });
});
