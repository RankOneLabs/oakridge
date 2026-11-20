import { expect, it } from "vitest";
import { DEFAULT_STUDY_SLICE_DRAFT, selectStudySliceLimits, selectWorkflowLaunchInput } from "./workflow-launch-input";

it("the default study slice is six cases and a $10 cap, in cents", () => {
  expect(selectStudySliceLimits(DEFAULT_STUDY_SLICE_DRAFT)).toEqual({ ok: true, value: { slice_case_limit: 6, slice_cap_cents: 1000 } });
});
it.each([["12", 1200], ["12.5", 1250], [" 0.01 ", 1], ["7.05", 705]])("a spending cap of $%s is %i cents", (cap_dollars, cents) => {
  const limits = selectStudySliceLimits({ case_limit: "3", cap_dollars });
  expect(limits.ok && limits.value.slice_cap_cents).toBe(cents);
});
it.each(["0", "1.5", "-2", "", "three"])("a slice case limit of %j is refused", (case_limit) => {
  expect(selectStudySliceLimits({ case_limit, cap_dollars: "10" })).toEqual({ ok: false, error: { detail: "Slice case limit must be a whole number of at least 1." } });
});
it.each(["$5", "1.234", "-1", "", "ten"])("a spending cap of %j is refused as not an amount", (cap_dollars) => {
  expect(selectStudySliceLimits({ case_limit: "3", cap_dollars })).toEqual({ ok: false, error: { detail: "Slice spending cap must be an amount in dollars, such as 10 or 12.50." } });
});
it("a spending cap of nothing is refused", () => {
  expect(selectStudySliceLimits({ case_limit: "3", cap_dollars: "0.00" })).toEqual({ ok: false, error: { detail: "Slice spending cap must be more than $0." } });
});
it("development takes nothing beyond the shared launch fields, whatever the slice draft says", () => {
  expect(selectWorkflowLaunchInput({ workflow_name: "development", study_slice: { case_limit: "", cap_dollars: "" } })).toEqual({ ok: true, value: { kind: "development" } });
});
it("a study takes its slice limits", () => {
  expect(selectWorkflowLaunchInput({ workflow_name: "study", study_slice: { case_limit: "4", cap_dollars: "2.50" } }))
    .toEqual({ ok: true, value: { kind: "study", slice: { slice_case_limit: 4, slice_cap_cents: 250 } } });
});
it("a study with an invalid slice is refused with the slice's reason", () => {
  expect(selectWorkflowLaunchInput({ workflow_name: "study", study_slice: { case_limit: "0", cap_dollars: "10" } }))
    .toEqual({ ok: false, error: { detail: "Slice case limit must be a whole number of at least 1." } });
});
it("a workflow the PWA has no input mapping for is refused", () => {
  expect(selectWorkflowLaunchInput({ workflow_name: "fan-out", study_slice: DEFAULT_STUDY_SLICE_DRAFT }))
    .toEqual({ ok: false, error: { detail: "The PWA cannot launch the fan-out workflow." } });
});
