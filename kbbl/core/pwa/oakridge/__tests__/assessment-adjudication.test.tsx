import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { CurrentAssessmentViewer } from "../components/molecules/CurrentAssessmentViewer";
import { CurrentAssessmentReview } from "../components/organisms/CurrentAssessmentReview";
import { AssessmentActionsPanel } from "../components/organisms/AssessmentActionsPanel";
import { AssessmentDecisionBar } from "../components/organisms/AssessmentDecisionBar";
import { useAssessmentAdjudication } from "../hooks/useAssessmentAdjudication";
import { CURRENT_ASSESSMENT, MODIFIED_ADJUDICATION_HISTORY, RECORDED_ADJUDICATION_HISTORY } from "../__fixtures__/current-assessments";
import type { ParkedGate, GateResumeRequest } from "../artifact-types";
import { KEPT_BUILDER_ACTIONS_REASON } from "../lib/assessment-adjudication";
import { AdjudicationHarness } from "./assessment-adjudication-harness";

const mutate = vi.fn();
vi.mock("../hooks/useResumeGate", () => ({ useResumeGate: () => ({ mutate, isPending: false, isError: false }) }));
vi.mock("../hooks/useCohortArtifact", () => ({ useCohortArtifact: () => ({ kind: "missing" }) }));
vi.mock("../hooks/useAssessmentHistory", () => ({ useAssessmentHistory: () => ({ data: [], isError: false, error: null }) }));
afterEach(() => { cleanup(); mutate.mockReset(); });
const assessmentChanges = { key: "request_assessment_changes", label: "Request assessment changes", payload_schema: "{feedback: text}",
  fields: [{ key: "feedback", label: "What must the assessment change?" }],
  submit: { kind: "review" as const, review: "assessment_review", decision: "request_assessment_changes", effect: "request_changes" as const, target_revision_id: "assessment:1" } };
const gate: ParkedGate = { id: "gate", run_id: "run", unit_id: "unit", stage_name: "assessment", gate_type: "artifact_approval", gate_step: "assessment_review", artifact_revision_id: "assessment:1", worktree: null,
  resume_actions: ["approve"], offered_decisions: ["accept", "request_build_changes", "request_assessment_changes"], run_state: "active", actionable: true,
  decision_definitions: [...["accept", "request_build_changes"].map(decision => ({ key: decision, label: decision === "accept" ? "Accept" : "Send to builder", fields: [], payload_schema: "adjudication",
    submit: { kind: "review" as const, review: "assessment_review", decision, target_revision_id: "assessment:1", effect: decision === "accept" ? "approve" as const : "request_changes" as const } })), assessmentChanges] };
const bar = () => within(screen.getByRole("region", { name: "Assessment decision" }));
const builderActions = () => within(screen.getByRole("region", { name: "builder actions" }));
const harness = (overrides: Partial<Parameters<typeof AdjudicationHarness>[0]> = {}) =>
  render(<AdjudicationHarness assessment={CURRENT_ASSESSMENT} revisionId="assessment:1" gate={gate} decisions={[]} {...overrides} />);

it("sends the kept builder action back without any per-action click", () => {
  harness();
  fireEvent.click(bar().getByRole("button", { name: "Send to builder (1)" }));
  const request = mutate.mock.calls[0]?.[0] as GateResumeRequest;
  expect(request.adjudication?.builder_feedback).toBe(screen.getByTestId("or-assessment-handoff-preview").textContent);
});
it("explains a validator rejection and points to the request for assessment changes", () => {
  harness({ gate: { ...gate, decision_definitions: gate.decision_definitions?.filter(definition => definition.key !== "accept") },
    decisions: [{ id: "v1", review: "engine:validator", decision: "request_changes", effect: "request_changes", target_revision_id: "assessment:1",
      payload: { feedback: "Assessment verdict must match item statuses and additional finding severities." }, created_at: "2026-11-20T00:00:00Z" }] });
  expect(bar().getByTestId("or-assessment-validation-rejection").textContent).toBe("This assessment failed validation, so it cannot be accepted: "
    + "Assessment verdict must match item statuses and additional finding severities. Request assessment changes to have the assessor correct it.");
});
it("accept stays blocked while a builder action is kept, and says why", () => {
  harness();
  expect([(bar().getByRole("button", { name: "Accept" }) as HTMLButtonElement).disabled, bar().getByText(KEPT_BUILDER_ACTIONS_REASON)]).toEqual([true, expect.anything()]);
});
it("dropping every builder action unblocks accept and blocks the send-back", () => {
  harness();
  fireEvent.click(builderActions().getByRole("button", { name: "Drop" }));
  expect([bar().getByRole("button", { name: "Accept" }), bar().getByRole("button", { name: "Send to builder (0)" })].map(button => (button as HTMLButtonElement).disabled)).toEqual([false, true]);
});
it("asks the assessor to revise from the decision bar", () => {
  harness();
  fireEvent.click(bar().getByRole("button", { name: "Request assessment changes…" }));
  fireEvent.change(bar().getByLabelText("Assessment feedback"), { target: { value: "Shorten the findings." } });
  fireEvent.click(bar().getByRole("button", { name: "Request assessment changes" }));
  expect(mutate.mock.calls[0]?.[0]).toMatchObject({ action: "request_assessment_changes", feedback: "Shorten the findings.", artifact_revision_id: "assessment:1" });
});
it("editing keeps the assessor's words visible beside the replacement", () => {
  harness();
  fireEvent.click(builderActions().getByRole("button", { name: "Edit" }));
  fireEvent.change(builderActions().getByLabelText("Replacement text"), { target: { value: "Replacement" } });
  expect([builderActions().getByText("Investigate the regression.").textContent, screen.getByTestId("or-assessment-handoff-preview").textContent]).toEqual(["Investigate the regression.", expect.stringContaining("Replacement")]);
});
it("hides action ids from the action lists", () => {
  harness();
  const lists = ["builder", "operator"].map(audience => screen.getByRole("region", { name: `${audience} actions` }).textContent).join("");
  expect(lists).not.toContain(CURRENT_ASSESSMENT.next_actions[0].id.slice(0, 8));
});
it("shows recorded dispositions inline and the decision in the bar once recorded", () => {
  harness({ decisions: RECORDED_ADJUDICATION_HISTORY });
  expect([builderActions().getByText("Dropped"), builderActions().getByText("Why dropped: Already fixed in another change."), bar().getByText(/^Accepted \(accept\)/)]).toHaveLength(3);
  expect(screen.queryByRole("group", { name: "Disposition" })).toBeNull();
});
it("shows a recorded edit and added actions in their audience lists", () => {
  harness({ gate: null, decisions: MODIFIED_ADJUDICATION_HISTORY });
  const edited = within(builderActions().getAllByRole("listitem")[0]);
  expect([edited.getByText("Edited"), edited.getByText("Add a regression test."), edited.getByText("Assessor wrote: Investigate the regression.")]).toHaveLength(3);
  for (const audience of ["builder", "operator"]) expect(within(screen.getByRole("region", { name: `${audience} actions` })).getByText(`Added ${audience} follow-up.`)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "+ Add action" })).toBeNull();
});
it("history for another revision leaves this one's actions undecided and editable", () => {
  harness({ revisionId: "assessment:2", gate: null, decisions: MODIFIED_ADJUDICATION_HISTORY });
  expect([builderActions().queryByText("Edited"), builderActions().getByRole("button", { name: "Keep" }).getAttribute("aria-pressed")]).toEqual([null, "true"]);
});
it("waits for the authority's history before presenting a sent decision as recorded", () => {
  harness();
  fireEvent.click(bar().getByRole("button", { name: "Send to builder (1)" }));
  act(() => (mutate.mock.calls[0]?.[1] as { onSuccess: () => void }).onSuccess());
  expect([bar().getByText("Decision submitted. Waiting for it to be recorded."), screen.queryByText("Kept")]).toEqual([expect.anything(), null]);
});
it("adds an operator action behind its button", () => {
  harness();
  fireEvent.click(screen.getByRole("button", { name: "+ Add action" }));
  fireEvent.change(screen.getByLabelText("Added action text"), { target: { value: "Cover the retired case." } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  expect([builderActions().getByText("Cover the retired case."), bar().getByRole("button", { name: "Send to builder (2)" })]).toHaveLength(2);
});
it("an open review shows its decisions above the sections and opens on the actions", () => {
  function Review() {
    const adjudication = useAssessmentAdjudication({ assessment: CURRENT_ASSESSMENT, revisionId: "assessment:1", gate, decisions: [] });
    return <CurrentAssessmentViewer assessment={CURRENT_ASSESSMENT} initialSection="actions" decisionBar={<AssessmentDecisionBar adjudication={adjudication} />}
      handoff={<AssessmentActionsPanel assessment={CURRENT_ASSESSMENT} adjudication={adjudication} />} />;
  }
  render(<Review />);
  const bar = screen.getByTestId("or-assessment-decision-bar");
  expect([screen.getByRole("tab", { name: /^Actions/ }).getAttribute("aria-selected"), Boolean(bar.compareDocumentPosition(screen.getByRole("tablist")) & Node.DOCUMENT_POSITION_FOLLOWING)]).toEqual(["true", true]);
});
it("an edit survives switching assessment sections", () => {
  function Review() {
    const adjudication = useAssessmentAdjudication({ assessment: CURRENT_ASSESSMENT, revisionId: "assessment:1", gate, decisions: [] });
    return <CurrentAssessmentViewer assessment={CURRENT_ASSESSMENT} initialSection="actions" handoff={<AssessmentActionsPanel assessment={CURRENT_ASSESSMENT} adjudication={adjudication} />} />;
  }
  render(<Review />);
  fireEvent.click(builderActions().getByRole("button", { name: "Edit" }));
  fireEvent.change(builderActions().getByLabelText("Replacement text"), { target: { value: "Replacement" } });
  fireEvent.click(screen.getByRole("tab", { name: "Tests" }));
  fireEvent.click(screen.getByRole("tab", { name: /^Actions/ }));
  expect((builderActions().getByLabelText("Replacement text") as HTMLTextAreaElement).value).toBe("Replacement");
});
it("an added action can be removed, which unblocks accept once every builder action is dropped", () => {
  harness();
  fireEvent.click(builderActions().getByRole("button", { name: "Drop" }));
  fireEvent.click(screen.getByRole("button", { name: "+ Add action" }));
  fireEvent.change(screen.getByLabelText("Added action text"), { target: { value: "Added by mistake." } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  fireEvent.click(builderActions().getByRole("button", { name: "Remove" }));
  expect([builderActions().queryByText("Added by mistake."), (bar().getByRole("button", { name: "Accept" }) as HTMLButtonElement).disabled]).toEqual([null, false]);
});
it("switching an edited action to Keep and back restores the replacement text", () => {
  harness();
  fireEvent.click(builderActions().getByRole("button", { name: "Edit" }));
  fireEvent.change(builderActions().getByLabelText("Replacement text"), { target: { value: "Replacement" } });
  fireEvent.click(builderActions().getByRole("button", { name: "Keep" }));
  fireEvent.click(builderActions().getByRole("button", { name: "Edit" }));
  expect((builderActions().getByLabelText("Replacement text") as HTMLTextAreaElement).value).toBe("Replacement");
});
describe("a review whose gate loads after the assessment", () => {
  const source = { run_id: "run", revision_id: "assessment:1", label: null, as_of: "2026-11-20" };
  const actionsTab = () => screen.getByRole("tab", { name: /^Actions/ }).getAttribute("aria-selected");
  it("opens on the actions once the gate arrives", () => {
    const view = render(<CurrentAssessmentReview body={CURRENT_ASSESSMENT} source={source} />);
    view.rerender(<CurrentAssessmentReview body={CURRENT_ASSESSMENT} source={source} gate={gate} />);
    expect(actionsTab()).toBe("true");
  });
  it("keeps a section the operator already chose", () => {
    const view = render(<CurrentAssessmentReview body={CURRENT_ASSESSMENT} source={source} />);
    fireEvent.click(screen.getByRole("tab", { name: "Tests" }));
    view.rerender(<CurrentAssessmentReview body={CURRENT_ASSESSMENT} source={source} gate={gate} />);
    expect(actionsTab()).toBe("false");
  });
});
