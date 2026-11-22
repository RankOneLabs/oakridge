import { expect, test } from "vitest";
import type { OperatorDefinitionBundle } from "../operator-contracts/projections/definition-view";
import { selectLaunchInputSchema, selectWorkflowLaunchInput } from "./workflow-launch-input";

const schemas: OperatorDefinitionBundle["schemas"] = [
  { key: "text", shape: { kind: "string", min_length: 0, max_length: 100 } },
  { key: "plan_body", shape: { kind: "record", fields: [{ key: "heading", schema: "text" }] } },
  { key: "optional(plan_body)", shape: { kind: "optional", item: "plan_body" } },
  { key: "study input", shape: { kind: "record", fields: [{ key: "approved_plan", schema: "optional(plan_body)" }] } },
  { key: "fixture input", shape: { kind: "record", fields: [{ key: "message", schema: "text" }] } },
];

function launchSchema(workflow: string) {
  const schema = selectLaunchInputSchema({
    key: workflow, root: "root", schemas, stages: [],
    units: [{ key: "root", input_schema: `${workflow} input`, stage: null, label: "Fixture", artifacts: [] }],
  });
  if (!schema) throw new Error("Fixture is missing its root input");
  return schema;
}

test("reads the launch fields of an independently authored fixture workflow", () => {
  expect(selectWorkflowLaunchInput(launchSchema("fixture"), { message: "Draft the folio" })).toEqual({
    ok: true, value: { message: "Draft the folio" },
  });
});

test("passes a valid approved plan as structured input", () => {
  expect(selectWorkflowLaunchInput(launchSchema("study"), { approved_plan: '{"heading":"Pilot"}' })).toEqual({
    ok: true, value: { approved_plan: { heading: "Pilot" } },
  });
});

test.each([["{", "valid JSON"], ["false", "optional(plan_body)"]])(
  "refuses an invalid approved plan %s",
  (approved_plan, message) => {
    const result = selectWorkflowLaunchInput(launchSchema("study"), { approved_plan });
    expect(result.ok ? null : result.error.detail).toContain(message);
  },
);
