import type { PlanTraceId } from "../../lib/plan";
// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import body from "../../lib/__fixtures__/build-items-brief.json";
import { parseBuildBrief } from "../../lib/build-brief";
import type { BuildItemAssessment, BuildItemFinding } from "../../lib/assessment";
import { BuildItemAssessmentViewer } from "./BuildItemAssessmentViewer";
const parsed = parseBuildBrief(body);
if (parsed?.shape !== "build_items") throw new Error("invalid fixture");
const brief = { ...parsed, build_items: [parsed.build_items[0]!, ...["B2", "B3"].map((id) => ({ ...parsed.build_items[0]!, id: id as PlanTraceId }))] };
const subjects: BuildItemFinding["subjects"][] = [[{ kind: "build_item", id: "B1" }], [{ kind: "build_item", id: "B2" as PlanTraceId }], [], [{ kind: "build_item", id: "missing" }], [{ kind: "task", id: "T1" }]];
const assessment: BuildItemAssessment = { shape: "build_items", head_sha: "abc", verdict: "pass_with_notes", test_evidence: null,
  findings: subjects.map((subjects, index) => ({ subjects, status: index === 1 ? "met" : "partial", description: `Finding ${index}`, evidence: [{ kind: "test", ref: `test-${index}`, detail: null }], item_path: `/findings/${index}` })),
  recommended_next_actions: [{ id: "action", text: "Run the follow-up" }] };
afterEach(cleanup);
test("renders item groups, assessor judgments, evidence, independent grade actions and next actions", () => {
  const onOpenItem = vi.fn();
  render(<BuildItemAssessmentViewer assessment={assessment} brief={{ kind: "found", value: brief }} source={{ revision_id: "v2|artifact|run|implementation|assessment:assessment-1" }} onOpenItem={onOpenItem} />);
  for (const [group, text] of [["Needs attention", "Finding 0"], ["Met (assessor's judgment)", "Finding 1"], ["Not assessed", "B3"], ["Cross-cutting findings", "Finding 2"], ["Unresolved item references", "missing"], ["Task findings", "Finding 4"]]) {
    expect(within(screen.getByTestId(`or-build-item-${group}`)).getAllByText(text, { exact: false })[0]).toBeTruthy();
  }
  expect(screen.getAllByText("Met (assessor's judgment)").length).toBeGreaterThan(0);
  expect(screen.queryByText(/verified/i)).toBeNull();
  expect(screen.getByText("test-0", { exact: false })).toBeTruthy();
  expect(screen.getByText("Run the follow-up")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open grading at /findings/1" }));
  expect(onOpenItem).toHaveBeenCalledWith({ source_revision_id: "assessment-1", item_path: "/findings/1" });
  expect(within(screen.getByTestId("or-build-item-Not assessed")).queryByRole("button")).toBeNull();
});
test("integration lists task and cohort-qualified build-item subjects without item comparison", () => {
  render(<BuildItemAssessmentViewer assessment={{ ...assessment, findings: [{ ...assessment.findings[0]!, subjects: [{ kind: "build_item", id: "B1", cohort_id: "pwa" }, { kind: "task", id: "T1" }] }] }} brief={{ kind: "found", value: brief }} isIntegration />);
  expect(screen.getByTestId("or-build-item-Findings").textContent).toContain("pwa");
  expect(screen.getByTestId("or-build-item-Findings").textContent).toContain("T1");
  expect(screen.queryByTestId("or-build-item-Not assessed")).toBeNull();
});
