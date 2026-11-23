import { afterEach, expect, test, vi } from "vitest";
import { createRun, invalidateCachedRunUnits } from "./client";
import type { CreateRunRequest } from "./launch-types";
import type { OperatorDefinitionDetail } from "./operator-contracts/projections/definition-view";
import sample from "./__fixtures__/v2-adapter-sample.json";
import definitionFixture from "./__fixtures__/v2-definition-detail.json";

const captured = definitionFixture.definition as unknown as OperatorDefinitionDetail;
const definition: OperatorDefinitionDetail = {
  ...captured,
  bundle: {
    key: "folio_fixture", root: "root", stages: ["drafting"],
    units: [{ key: "root", stage: null, label: "Root", input_schema: "launch", artifacts: [] }],
    schemas: [
      { key: "launch", shape: { kind: "record", fields: [{ key: "note", schema: "text" }] } },
      { key: "text", shape: { kind: "string", min_length: 1, max_length: 500 } },
    ],
  },
  graph: { nodes: [{ key: "drafting", stage: "drafting", depends_on: [] }], edges: [] },
  workflow: { ...captured.workflow, stages: { drafting: captured.workflow.stages.analysis } },
};
const request: CreateRunRequest = {
  workflow_def_id: definition.definition_id, project_id: null, workflow_input: { note: "Set the type" },
  session_settings: { drafting: {
    author: { harness: "claude-code", model: "sonnet", effort: null },
    spec_editor: { harness: "codex", model: "gpt-6-sol", effort: null },
  } },
  grading_enabled: false,
};
const mockFetch = () => vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
  const url = String(input);
  return Response.json(url.includes("/api/definitions/") ? definition
    : url.endsWith("/api/runs") ? { kind: "committed", run_id: sample.run.run_id, event_id: "event-2" }
    : url.includes("/units") ? sample.units : sample.run);
});
afterEach(() => { vi.restoreAllMocks(); invalidateCachedRunUnits(null); });

test.each([true, false])("launches a fixture workflow with its projected input and grading setting %s", async (grading_enabled) => {
  const fetch = mockFetch();
  await createRun({ ...request, grading_enabled }, "launch-1");
  const launch = fetch.mock.calls.find(([path]) => String(path).endsWith("/api/runs"));
  expect(JSON.parse(String(launch?.[1]?.body))).toMatchObject({
    request_id: "launch-1", definition_id: definition.definition_id, input: request.workflow_input,
    config: { sessions: request.session_settings, grading_enabled },
  });
});

test("invalid input is refused before posting a launch", async () => {
  const fetch = mockFetch();
  await expect(createRun({ ...request, workflow_input: { note: 8 } }, "launch-2")).rejects.toThrow("launch schema");
  expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});
