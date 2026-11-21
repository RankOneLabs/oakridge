import { describe, expect, it } from "vitest";
import { CURRENT_ASSESSMENT, MET_WITH_REGRESSION, MODIFIED_ADJUDICATION_HISTORY, OPERATOR_ONLY_ASSESSMENT, RECORDED_ADJUDICATION_HISTORY } from "../__fixtures__/current-assessments";
import { parseCurrentAssessment, selectAdditionalFindings, selectAssessmentActions, selectDerivedVerdict, selectItemAssessmentGroups } from "./assessment";
import { addAction, initialAdjudication, selectActionSourceLabel, selectAdjudicationPayload, selectReworkActionCount, selectReworkPreview, selectDecisionButtonLabel, selectPendingDisposition, selectRecordedAssessmentDecision, selectSendability, setDisposition, type ReviewDecisionDefinition } from "./assessment-adjudication";

describe("current assessment selectors", () => {
  it("parses the declared contract", () => expect(parseCurrentAssessment(CURRENT_ASSESSMENT).ok).toBe(true));
  it("a blocking additional finding fails verdict without changing a met item", () => expect({ groups: selectItemAssessmentGroups(MET_WITH_REGRESSION).map(group => [group.status, group.count]), verdict: selectDerivedVerdict(MET_WITH_REGRESSION) })
    .toEqual({ groups: [["not_met", 0], ["partial", 0], ["met", 1]], verdict: { verdict: "fail", has_mismatch: false } }));
  it("flags authored verdict mismatch", () => expect(selectDerivedVerdict({ ...MET_WITH_REGRESSION, verdict: "pass" }).has_mismatch).toBe(true));
  it("empty related build ids are unattributed", () => expect(selectAdditionalFindings({ ...CURRENT_ASSESSMENT, additional_findings: CURRENT_ASSESSMENT.additional_findings.map(finding => ({ ...finding, related_build_item_ids: [] })) })[0].is_unattributed).toBe(true));
  it("resolves related item labels", () => expect(selectAdditionalFindings(CURRENT_ASSESSMENT, [{ id: "B1", label: "Build feature" }])[0].labels).toEqual([{ id: "B1", label: "Build feature" }]));
  it("partitions actions by audience", () => expect([selectAssessmentActions(CURRENT_ASSESSMENT).builder, selectAssessmentActions(CURRENT_ASSESSMENT).operator].map(actions => actions.map(action => action.audience))).toEqual([["rework"], ["operator"]]));
});
describe("pending adjudication", () => {
  const builder = CURRENT_ASSESSMENT.next_actions[0].id;
  const operator = CURRENT_ASSESSMENT.next_actions[1].id;
  const feedback: ReviewDecisionDefinition = { role: "feedback", definition: { key: "send", label: "Send to expander",
    payload_schema: "{}", adjudication: "feedback", assessment: "assessment", fields: [],
    submit: { kind: "review", review: "expansion_review", decision: "send", effect: "request_changes", target_revision_id: "a" } } };
  const accept: ReviewDecisionDefinition = { role: "accept", definition: { ...feedback.definition, label: "Accept", adjudication: "accept",
    submit: { kind: "review", review: "expansion_review", decision: "accept", effect: "approve", target_revision_id: "a" } } };
  const initial = initialAdjudication(CURRENT_ASSESSMENT);
  const operatorKept = setDisposition(initial, operator, { kind: "accept" });
  const dropped = setDisposition(operatorKept, builder, { kind: "reject", reason: " " });
  const reworkKept = setDisposition(operatorKept, builder, { kind: "accept" });
  const added = (state: typeof initial) => addAction(state, { audience: "rework", source: { kind: "item_assessment", id: "B1" }, text: "Added" });

  it("every action starts undecided", () => expect(CURRENT_ASSESSMENT.next_actions.map(action => selectPendingDisposition(initial, action.id))).toEqual([null, null]));
  it("sets the first choice for an action", () => expect(selectPendingDisposition(operatorKept, operator)?.disposition).toBe("accepted"));
  it.each(["accept", "feedback"] as const)("blocks %s when an action is undecided", role => {
    expect(selectSendability(operatorKept, role)).toEqual({ kind: "blocked", reason: "Keep, edit or drop every action." });
  });
  it.each([reworkKept, setDisposition(operatorKept, builder, { kind: "edit", final_text: "Fix it" }), added(dropped)])(
    "blocks accepting when rework would be delivered", state => {
      expect(selectSendability(state, "accept")).toEqual({ kind: "blocked", reason: "Accept sends nothing back. Drop the rework actions, or send them." });
    });
  it("requires at least one rework action for feedback", () => {
    expect(selectSendability(dropped, "feedback")).toEqual({ kind: "blocked", reason: "Keep, edit or add at least one rework action." });
  });
  it("counts the rework actions a send-back delivers", () => expect(selectReworkActionCount(added(reworkKept))).toBe(2));
  it("uses definition labels and adds the count to the feedback button", () => {
    expect([selectDecisionButtonLabel(reworkKept, feedback), selectDecisionButtonLabel(reworkKept, accept)]).toEqual(["Send to expander (1)", "Accept"]);
  });
  it("an empty drop reason is not recorded", () => {
    const payload = selectAdjudicationPayload(dropped, accept);
    expect(payload.ok && payload.value.entries[0]).toMatchObject({ disposition: "rejected" });
    expect(payload.ok && payload.value.entries[0]).not.toHaveProperty("reason");
  });
  it("names an action's source the way the tabs do", () => expect([selectActionSourceLabel({ kind: "additional_finding", id: "F1" }), selectActionSourceLabel({ kind: "item_assessment", id: "B1" })]).toEqual(["From finding F1", "From B1"]));
  it("preview equals the exact submitted feedback and excludes operator actions", () => {
    let state = setDisposition(initialAdjudication(CURRENT_ASSESSMENT), builder, { kind: "edit", final_text: "Replacement" });
    state = setDisposition(state, operator, { kind: "accept" });
    state = addAction(state, { audience: "rework", source: { kind: "item_assessment", id: "B1" }, text: "Added" });
    const payload = selectAdjudicationPayload(state, feedback);
    expect(payload.ok ? payload.value.rework_feedback : null).toBe(selectReworkPreview(state));
    expect(selectReworkPreview(state)).not.toContain(CURRENT_ASSESSMENT.next_actions[1].text);
  });
  it("rejecting all builder actions blocks send while accept stays sendable", () => {
    let state = setDisposition(initialAdjudication(CURRENT_ASSESSMENT), builder, { kind: "reject", reason: "Already fixed" });
    state = setDisposition(state, operator, { kind: "accept" });
    expect([selectReworkPreview(state), selectSendability(state, "feedback").kind, selectSendability(state, "accept").kind]).toEqual(["", "blocked", "sendable"]);
  });
  it("operator-only accepted actions do not appear in the preview", () => expect(selectReworkPreview(setDisposition(initialAdjudication(OPERATOR_ONLY_ASSESSMENT), operator, { kind: "accept" }))).toBe(""));
});
describe("recorded adjudication", () => {
  it("selects the latest matching assessment decision despite a redirected effect target", () => {
    expect(selectRecordedAssessmentDecision([...RECORDED_ADJUDICATION_HISTORY, ...MODIFIED_ADJUDICATION_HISTORY], "assessment:1"))
      .toBe(MODIFIED_ADJUDICATION_HISTORY[0]);
  });
  it("leaves a new revision without recorded dispositions", () => {
    expect(selectRecordedAssessmentDecision(MODIFIED_ADJUDICATION_HISTORY, "assessment:2")).toBeNull();
  });
});
