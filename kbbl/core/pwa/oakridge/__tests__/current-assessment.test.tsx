import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { CurrentAssessmentViewer } from "../components/molecules/AssessmentViewer";
import { CurrentBuilderHandoffPanel } from "../components/organisms/BuilderHandoffPanel";
import { CURRENT_ASSESSMENT, NOT_MET_ASSESSMENT, RECORDED_ADJUDICATION_HISTORY } from "../__fixtures__/current-assessments";
import type { ParkedGate, GateResumeRequest } from "../artifact-types";
const mutate = vi.fn();
vi.mock("../hooks/useResumeGate", () => ({ useResumeGate: () => ({ mutate, isPending: false, isError: false }) }));
afterEach(() => { cleanup(); mutate.mockReset(); });
const gate: ParkedGate = { id: "gate", run_id: "run", unit_id: "unit", stage_name: "assessment", gate_type: "artifact_approval", gate_step: "assessment_review", artifact_revision_id: "assessment:1", worktree: null,
  resume_actions: ["approve"], offered_decisions: ["accept", "request_build_changes"], run_state: "active", actionable: true,
  decision_definitions: ["accept", "request_build_changes"].map(decision => ({ key: decision, label: decision, fields: [], payload_schema: "adjudication", submit: { kind: "review", review: "assessment_review", decision, target_revision_id: "assessment:1", effect: decision === "accept" ? "approve" : "request_changes" } })) };
it("shows additional findings when all items are met without legacy sections", () => {
  render(<CurrentAssessmentViewer assessment={CURRENT_ASSESSMENT} />);
  expect(screen.getByTestId("or-assessment-additional-findings").textContent).toContain("unrelated regression");
  expect(screen.queryByText("Task findings")).toBeNull(); expect(screen.queryByText("Cross-cutting findings")).toBeNull(); expect(screen.queryByText("Unresolved item references")).toBeNull();
});
it("observation grades remain distinct from assessor status", () => {
  render(<CurrentAssessmentViewer assessment={CURRENT_ASSESSMENT} />);
  expect(screen.getAllByRole("region", { name: "Observation grade" }).length).toBe(2);
  expect(screen.getByLabelText("Assessor status").textContent).toBe("met");
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
  expect(screen.queryByText("Pending: rejected")).toBeNull(); expect(screen.getByText("Recorded")).toBeTruthy(); expect(screen.getByText("Reason: Already fixed in another change.")).toBeTruthy();
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
it("editing keeps original words visible beside replacement", () => {
  panel(); fireEvent.click(within(screen.getByRole("region", { name: "builder actions" })).getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText(`Replacement for ${CURRENT_ASSESSMENT.next_actions[0].id}`), { target: { value: "Replacement" } });
  expect(screen.getByText("Original: Investigate the regression.")).toBeTruthy(); expect(screen.getByTestId("or-assessment-handoff-preview").textContent).toContain("Replacement");
});
