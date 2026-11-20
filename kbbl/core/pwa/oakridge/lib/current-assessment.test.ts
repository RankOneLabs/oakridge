import { describe, expect, it } from "vitest";
import { CURRENT_ASSESSMENT, MET_WITH_REGRESSION, MODIFIED_ADJUDICATION_HISTORY, OPERATOR_ONLY_ASSESSMENT, RECORDED_ADJUDICATION_HISTORY } from "../__fixtures__/current-assessments";
import { parseCurrentAssessment, selectAdditionalFindings, selectAssessmentActions, selectDerivedVerdict, selectItemAssessmentGroups } from "./assessment";
import { addAction, initialAdjudication, selectActionSourceLabel, selectAdjudicationPayload, selectBuilderActionCount, selectBuilderPreview, selectDecisionButtonLabel, selectPendingDisposition, selectRecordedAssessmentDecision, selectSendability, setDisposition } from "./assessment-adjudication";

describe("current assessment selectors", () => {
  it("parses the declared contract", () => expect(parseCurrentAssessment(CURRENT_ASSESSMENT).ok).toBe(true));
  it("a blocking additional finding fails verdict without changing a met item", () => expect({ groups: selectItemAssessmentGroups(MET_WITH_REGRESSION).map(group => [group.status, group.count]), verdict: selectDerivedVerdict(MET_WITH_REGRESSION) })
    .toEqual({ groups: [["not_met", 0], ["partial", 0], ["met", 1]], verdict: { verdict: "fail", has_mismatch: false } }));
  it("flags authored verdict mismatch", () => expect(selectDerivedVerdict({ ...MET_WITH_REGRESSION, verdict: "pass" }).has_mismatch).toBe(true));
  it("empty related build ids are unattributed", () => expect(selectAdditionalFindings({ ...CURRENT_ASSESSMENT, additional_findings: CURRENT_ASSESSMENT.additional_findings.map(finding => ({ ...finding, related_build_item_ids: [] })) })[0].is_unattributed).toBe(true));
  it("resolves related item labels", () => expect(selectAdditionalFindings(CURRENT_ASSESSMENT, [{ id: "B1", label: "Build feature" }])[0].labels).toEqual([{ id: "B1", label: "Build feature" }]));
  it("partitions actions by audience", () => expect([selectAssessmentActions(CURRENT_ASSESSMENT).builder, selectAssessmentActions(CURRENT_ASSESSMENT).operator].map(actions => actions.map(action => action.audience))).toEqual([["builder"], ["operator"]]));
});
describe("pending adjudication", () => {
  const builder = CURRENT_ASSESSMENT.next_actions[0].id;
  const operator = CURRENT_ASSESSMENT.next_actions[1].id;
  it("every action starts kept", () => expect(CURRENT_ASSESSMENT.next_actions.map(action => selectPendingDisposition(initialAdjudication(CURRENT_ASSESSMENT), action.id).disposition)).toEqual(["accepted", "accepted"]));
  it("a kept builder action can be sent back without touching anything", () => expect(selectSendability(initialAdjudication(CURRENT_ASSESSMENT), "request_changes").kind).toBe("sendable"));
  it("a kept builder action blocks accepting, so it is never silently dropped", () => expect(selectSendability(initialAdjudication(CURRENT_ASSESSMENT), "approve").kind).toBe("blocked"));
  it("an added builder action blocks accepting too", () => {
    const dropped = setDisposition(initialAdjudication(CURRENT_ASSESSMENT), builder, { kind: "reject", reason: "" });
    expect(selectSendability(addAction(dropped, { audience: "builder", source: { kind: "item_assessment", id: "B1" }, text: "Added" }), "approve").kind).toBe("blocked");
  });
  it("counts the builder actions a send-back delivers", () => {
    const state = addAction(initialAdjudication(CURRENT_ASSESSMENT), { audience: "builder", source: { kind: "item_assessment", id: "B1" }, text: "Added" });
    expect(selectBuilderActionCount(state)).toBe(2);
  });
  it("names the count on a send-back button only", () => {
    const definition = { key: "send", label: "Send to builder", payload_schema: "adjudication", fields: [], submit: { kind: "review" as const, review: "assessment_review", decision: "send", effect: "request_changes" as const, target_revision_id: "a" } };
    const state = initialAdjudication(CURRENT_ASSESSMENT);
    expect([selectDecisionButtonLabel(state, { definition, effect: "request_changes" }), selectDecisionButtonLabel(state, { definition: { ...definition, label: "Accept" }, effect: "approve" })]).toEqual(["Send to builder (1)", "Accept"]);
  });
  it("an empty drop reason is not recorded", () => {
    const payload = selectAdjudicationPayload(setDisposition(initialAdjudication(CURRENT_ASSESSMENT), builder, { kind: "reject", reason: " " }), "approve");
    expect(payload.ok && payload.value.entries[0]).not.toHaveProperty("reason");
  });
  it("names an action's source the way the tabs do", () => expect([selectActionSourceLabel({ kind: "additional_finding", id: "F1" }), selectActionSourceLabel({ kind: "item_assessment", id: "B1" })]).toEqual(["From finding F1", "From B1"]));
  it("preview equals the exact submitted feedback and excludes operator actions", () => {
    let state = setDisposition(initialAdjudication(CURRENT_ASSESSMENT), builder, { kind: "edit", final_text: "Replacement" });
    state = setDisposition(state, operator, { kind: "accept" });
    state = addAction(state, { audience: "builder", source: { kind: "item_assessment", id: "B1" }, text: "Added" });
    const payload = selectAdjudicationPayload(state, "request_changes");
    expect(payload.ok ? payload.value.builder_feedback : null).toBe(selectBuilderPreview(state));
    expect(selectBuilderPreview(state)).not.toContain(CURRENT_ASSESSMENT.next_actions[1].text);
  });
  it("rejecting all builder actions blocks send while accept stays sendable", () => {
    let state = setDisposition(initialAdjudication(CURRENT_ASSESSMENT), builder, { kind: "reject", reason: "Already fixed" });
    state = setDisposition(state, operator, { kind: "accept" });
    expect([selectBuilderPreview(state), selectSendability(state, "request_changes").kind, selectSendability(state, "approve").kind]).toEqual(["", "blocked", "sendable"]);
  });
  it("operator-only accepted actions do not appear in the preview", () => expect(selectBuilderPreview(setDisposition(initialAdjudication(OPERATOR_ONLY_ASSESSMENT), operator, { kind: "accept" }))).toBe(""));
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
