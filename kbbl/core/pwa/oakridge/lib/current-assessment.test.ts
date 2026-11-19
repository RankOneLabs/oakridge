import { describe, expect, it } from "vitest";
import { CURRENT_ASSESSMENT, MET_WITH_REGRESSION, MODIFIED_ADJUDICATION_HISTORY, OPERATOR_ONLY_ASSESSMENT, RECORDED_ADJUDICATION_HISTORY } from "../__fixtures__/current-assessments";
import { parseCurrentAssessment, selectAdditionalFindings, selectAssessmentActions, selectDerivedVerdict, selectItemAssessmentGroups } from "./assessment";
import { addAction, initialAdjudication, selectAdjudicationPayload, selectBuilderPreview, selectRecordedAssessmentDecision, selectSendability, setDisposition } from "./assessment-handoff";

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
  it("undecided actions block submission", () => expect(selectSendability(initialAdjudication(CURRENT_ASSESSMENT), "approve").kind).toBe("blocked"));
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
