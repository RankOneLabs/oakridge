import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { AdjudicationHistory } from "../components/molecules/AdjudicationHistory";
import { CurrentAssessmentViewer } from "../components/molecules/AssessmentViewer";
import { CurrentBuilderHandoffPanel } from "../components/organisms/BuilderHandoffPanel";
import { CURRENT_ASSESSMENT, MODIFIED_ADJUDICATION_HISTORY, NOT_MET_ASSESSMENT, RECORDED_ADJUDICATION_HISTORY } from "../__fixtures__/current-assessments";
import type { ParkedGate, GateResumeRequest } from "../artifact-types";
const mutate = vi.fn();
vi.mock("../hooks/useResumeGate", () => ({ useResumeGate: () => ({ mutate, isPending: false, isError: false }) }));
afterEach(() => { cleanup(); mutate.mockReset(); });
const gate: ParkedGate = { id: "gate", run_id: "run", unit_id: "unit", stage_name: "assessment", gate_type: "artifact_approval", gate_step: "assessment_review", artifact_revision_id: "assessment:1", worktree: null,
  resume_actions: ["approve"], offered_decisions: ["accept", "request_build_changes"], run_state: "active", actionable: true,
  decision_definitions: ["accept", "request_build_changes"].map(decision => ({ key: decision, label: decision, fields: [], payload_schema: "adjudication", submit: { kind: "review", review: "assessment_review", decision, target_revision_id: "assessment:1", effect: decision === "accept" ? "approve" : "request_changes" } })) };
it("shows additional findings when all items are met without legacy sections", () => {
  render(<CurrentAssessmentViewer assessment={CURRENT_ASSESSMENT} />);
  fireEvent.click(screen.getByRole("tab", { name: /^Findings/ }));
  expect(screen.getByTestId("or-assessment-additional-findings").textContent).toContain("unrelated regression");
  expect(screen.queryByText("Task findings")).toBeNull(); expect(screen.queryByText("Cross-cutting findings")).toBeNull(); expect(screen.queryByText("Unresolved item references")).toBeNull();
});
it("observation grades remain distinct from assessor status", () => {
  render(<CurrentAssessmentViewer assessment={CURRENT_ASSESSMENT} />);
  expect(screen.getByLabelText("Assessor status").textContent).toBe("met");
  const itemGrades = screen.getAllByRole("region", { name: "Observation grade" }).length;
  fireEvent.click(screen.getByRole("tab", { name: /^Findings/ }));
  expect(itemGrades + screen.getAllByRole("region", { name: "Observation grade" }).length).toBe(2);
});
it("attention status filter excludes met items", () => {
  render(<CurrentAssessmentViewer assessment={{ ...NOT_MET_ASSESSMENT, item_assessments: [...NOT_MET_ASSESSMENT.item_assessments, { ...CURRENT_ASSESSMENT.item_assessments[0], subject: { kind: "build_item", id: "B2" } }] }} />);
  fireEvent.change(screen.getByLabelText("Status filter"), { target: { value: "needs_attention" } });
  expect(screen.getAllByTestId("or-criterion-check").map(item => item.getAttribute("data-status"))).toEqual(["not_met"]);
});
function panel() { return render(<CurrentBuilderHandoffPanel assessment={CURRENT_ASSESSMENT} revisionId="assessment:1" gate={gate} decisions={[]} />); }
it("rejection is Pending until authority history supplies the recorded reason", () => {
  const view = panel();
  fireEvent.click(within(screen.getByRole("region", { name: "builder actions" })).getByRole("button", { name: "Reject" }));
  expect(screen.getByText("Pending: rejected")).toBeTruthy();
  view.rerender(<CurrentBuilderHandoffPanel assessment={CURRENT_ASSESSMENT} revisionId="assessment:1" gate={gate} decisions={RECORDED_ADJUDICATION_HISTORY} />);
  const builderActions = within(screen.getByRole("region", { name: "builder actions" }));
  expect(builderActions.queryByText("Pending: rejected")).toBeNull();
  expect(builderActions.getByText("Recorded: rejected")).toBeTruthy();
  expect(builderActions.getByText("Original: Investigate the regression.")).toBeTruthy();
  expect(builderActions.getByText("Reason: Already fixed in another change.")).toBeTruthy();
  expect(builderActions.queryByRole("button", { name: "Accept" })).toBeNull();
  expect(within(screen.getByRole("region", { name: "operator actions" })).getByText("Recorded: accepted")).toBeTruthy();
  expect(within(screen.getByTestId("or-adjudication-history")).getByText("Reason: Already fixed in another change.")).toBeTruthy();
});
it("shows recorded modifications and added actions inline in their audience lists", () => {
  render(<CurrentBuilderHandoffPanel assessment={CURRENT_ASSESSMENT} revisionId="assessment:1" gate={null} decisions={MODIFIED_ADJUDICATION_HISTORY} />);
  const builderActions = within(screen.getByRole("region", { name: "builder actions" }));
  const modified = within(builderActions.getAllByRole("listitem")[0]);
  expect(modified.getByText("Recorded: modified")).toBeTruthy();
  expect(modified.getByText("Original: Investigate the regression.")).toBeTruthy();
  expect(modified.getByText("Final: Add a regression test.")).toBeTruthy();
  expect(modified.getByText("Reason: Narrow the follow-up.")).toBeTruthy();
  for (const audience of ["builder", "operator"]) {
    const actions = within(screen.getByRole("region", { name: `${audience} actions` }));
    expect(actions.getByText("Recorded: added")).toBeTruthy();
    expect(actions.getByText(`Added by operator: Added ${audience} follow-up.`)).toBeTruthy();
  }
  expect(screen.queryByText(/Pending:/)).toBeNull();
  expect(screen.queryByRole("region", { name: "Add action" })).toBeNull();
});
it("keeps dispositions pending when recorded history belongs to another revision", () => {
  render(<CurrentBuilderHandoffPanel assessment={CURRENT_ASSESSMENT} revisionId="assessment:2" gate={null} decisions={MODIFIED_ADJUDICATION_HISTORY} />);
  const actions = within(screen.getByRole("region", { name: "builder actions" }));
  expect(actions.getByText("Pending: undecided")).toBeTruthy();
  expect(actions.queryByText(/Recorded:/)).toBeNull();
  expect(actions.queryByText(/Added by operator:/)).toBeNull();
});
it("waits for authority history before presenting a successful mutation as recorded dispositions", () => {
  panel();
  for (const button of screen.getAllByRole("button", { name: "Accept" })) fireEvent.click(button);
  fireEvent.click(screen.getByRole("button", { name: "Accept assessment" }));
  const callbacks = mutate.mock.calls[0]?.[1] as { onSuccess: () => void };
  act(() => callbacks.onSuccess());
  expect(within(screen.getByRole("region", { name: "builder actions" })).getByText("Pending: accepted")).toBeTruthy();
  expect(screen.queryByText("Recorded: accepted")).toBeNull();
});
it("preview equals submitted feedback and current actions have no checkboxes", () => {
  panel();
  for (const button of screen.getAllByRole("button", { name: "Accept" })) fireEvent.click(button);
  const preview = screen.getByTestId("or-assessment-handoff-preview").textContent;
  fireEvent.click(screen.getByRole("button", { name: "Request build changes" }));
  const request = mutate.mock.calls[0]?.[0] as GateResumeRequest;
  expect(request.adjudication?.builder_feedback).toBe(preview);
  expect(screen.queryByRole("checkbox")).toBeNull(); expect(screen.queryByText(/publish a new assessment revision/)).toBeNull();
});
it("rejecting every builder action disables requesting changes", () => {
  panel();
  fireEvent.click(within(screen.getByRole("region", { name: "builder actions" })).getByRole("button", { name: "Reject" }));
  fireEvent.click(within(screen.getByRole("region", { name: "operator actions" })).getByRole("button", { name: "Accept" }));
  expect((screen.getByRole("button", { name: "Request build changes" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Accept assessment" }) as HTMLButtonElement).disabled).toBe(false);
});
it("an action draft survives switching assessment sections", () => {
  render(<CurrentAssessmentViewer assessment={CURRENT_ASSESSMENT} handoff={<CurrentBuilderHandoffPanel assessment={CURRENT_ASSESSMENT} revisionId="assessment:1" gate={gate} decisions={[]} />} />);
  const replacement = `Replacement for ${CURRENT_ASSESSMENT.next_actions[0].id}`;
  fireEvent.click(screen.getByRole("tab", { name: /^Actions/ }));
  fireEvent.click(within(screen.getByRole("region", { name: "builder actions" })).getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText(replacement), { target: { value: "Replacement" } });
  fireEvent.click(screen.getByRole("tab", { name: "Tests" }));
  fireEvent.click(screen.getByRole("tab", { name: /^Actions/ }));
  expect((screen.getByLabelText(replacement) as HTMLTextAreaElement).value).toBe("Replacement");
});
it("editing keeps original words visible beside replacement", () => {
  panel(); fireEvent.click(within(screen.getByRole("region", { name: "builder actions" })).getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText(`Replacement for ${CURRENT_ASSESSMENT.next_actions[0].id}`), { target: { value: "Replacement" } });
  expect(screen.getByText("Original: Investigate the regression.")).toBeTruthy(); expect(screen.getByTestId("or-assessment-handoff-preview").textContent).toContain("Replacement");
});

it.each([
  { review: "assessment_review", decision: "accept", effect: "approve" as const, label: "Recorded builder preview", absent: "Transmitted builder feedback" },
  { review: "assessment_review", decision: "request_build_changes", effect: "request_changes" as const, label: "Transmitted builder feedback", absent: "Recorded builder preview" },
  { review: "integration_review", decision: "request_changes", effect: "request_changes" as const, label: "Transmitted builder feedback", absent: "Recorded builder preview" },
])("history distinguishes $review $decision feedback from previews", ({ review, decision, effect, label, absent }) => {
  const decisions = MODIFIED_ADJUDICATION_HISTORY.map(recorded => ({ ...recorded, review, decision, effect }));
  render(<AdjudicationHistory decisions={decisions} revisionId="assessment:1" />);
  expect(screen.getByText(label)).toBeTruthy();
  expect(screen.queryByText(absent)).toBeNull();
  expect(screen.getByTestId("or-adjudication-history").querySelector("pre")?.textContent).toBe(decisions[0].adjudication?.builder_feedback);
});
