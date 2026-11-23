import { expect, it, test } from "vitest";
import type { OperatorDefinitionBundle } from "../operator-contracts/projections/definition-view";
import { DEFAULT_STUDY_SLICE_DRAFT, selectStudySliceLimits, selectHasEpicFields, selectLaunchInputSchema, selectWorkflowLaunchInput, type EpicLaunchDraft } from "./workflow-launch-input";

const schemas: OperatorDefinitionBundle["schemas"] = [
  { key: "text", shape: { kind: "string", min_length: 0, max_length: 100 } },
  { key: "plan_body", shape: { kind: "record", fields: [{ key: "heading", schema: "text" }] } },
  { key: "optional(plan_body)", shape: { kind: "optional", item: "plan_body" } },
  { key: "study input", shape: { kind: "record", fields: [{ key: "approved_plan", schema: "optional(plan_body)" }] } },
  { key: "fixture input", shape: { kind: "record", fields: [{ key: "message", schema: "text" }] } },
];

const epic: EpicLaunchDraft = { title: "", notes: "", policy: "guarded", source: { kind: "typed" }, repositories: [] };
const emptyControls = { epic, studySlice: DEFAULT_STUDY_SLICE_DRAFT };

function launchSchema(workflow: string) {
  const schema = selectLaunchInputSchema({
    key: workflow, root: "root", schemas, stages: [],
    units: [{ key: "root", input_schema: `${workflow} input`, stage: null, label: "Fixture", artifacts: [] }],
  });
  if (!schema) throw new Error("Fixture is missing its root input");
  return schema;
}

test.each([
  ["development", true],
  ["study", true],
  ["generic", false],
  [undefined, false],
] as const)("selects epic fields for form %s: %s", (form, expected) => {
  expect(selectHasEpicFields(form)).toBe(expected);
});

test("reads the launch fields of an independently authored fixture workflow", () => {
  expect(selectWorkflowLaunchInput(launchSchema("fixture"), { ...emptyControls, fields: { message: "Draft the folio" } })).toEqual({
    ok: true, value: { message: "Draft the folio" },
  });
});

test("passes a valid approved plan as structured input", () => {
  expect(selectWorkflowLaunchInput(launchSchema("study"), { ...emptyControls, fields: { approved_plan: '{"heading":"Pilot"}' } })).toEqual({
    ok: true, value: { approved_plan: { heading: "Pilot" } },
  });
});

test.each([["{", "valid JSON"], ["false", "optional(plan_body)"]])(
  "refuses an invalid approved plan %s",
  (approved_plan, message) => {
    const result = selectWorkflowLaunchInput(launchSchema("study"), { ...emptyControls, fields: { approved_plan } });
    expect(result.ok ? null : result.error.detail).toContain(message);
  },
);

it("the default study slice is six cases and a $10 cap, in cents", () => {
  expect(selectStudySliceLimits(DEFAULT_STUDY_SLICE_DRAFT)).toEqual({ ok: true, value: { slice_case_limit: 6, slice_cap_cents: 1000 } });
});
it.each([["12", 1200], ["12.5", 1250], [" 0.01 ", 1], ["7.05", 705]])("a spending cap of $%s is %i cents", (cap_dollars, cents) => {
  const limits = selectStudySliceLimits({ case_limit: "3", cap_dollars });
  expect(limits.ok && limits.value.slice_cap_cents).toBe(cents);
});
it.each(["0", "1.5", "-2", "", "three", "9007199254740993", "9".repeat(400)])("a slice case limit of %j is refused", (case_limit) => {
  expect(selectStudySliceLimits({ case_limit, cap_dollars: "10" })).toEqual({ ok: false, error: { detail: "Slice case limit must be a whole number of at least 1." } });
});
it.each(["$5", "1.234", "-1", "", "ten"])("a spending cap of %j is refused as not an amount", (cap_dollars) => {
  expect(selectStudySliceLimits({ case_limit: "3", cap_dollars })).toEqual({ ok: false, error: { detail: "Slice spending cap must be an amount in dollars, such as 10 or 12.50." } });
});
it.each(["90071992547410", "9".repeat(400)])("a spending cap of $%s is refused as too large to send exactly", (cap_dollars) => {
  expect(selectStudySliceLimits({ case_limit: "3", cap_dollars })).toEqual({ ok: false, error: { detail: "Slice spending cap is too large." } });
});
it("the largest spending cap that can be sent exactly is accepted", () => {
  const limits = selectStudySliceLimits({ case_limit: "3", cap_dollars: "90071992547409.91" });
  expect(limits.ok && limits.value.slice_cap_cents).toBe(Number.MAX_SAFE_INTEGER);
});
it("a spending cap of nothing is refused", () => {
  expect(selectStudySliceLimits({ case_limit: "3", cap_dollars: "0.00" })).toEqual({ ok: false, error: { detail: "Slice spending cap must be more than $0." } });
});
