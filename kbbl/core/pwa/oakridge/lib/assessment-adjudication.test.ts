import { describe, expect, it } from "vitest";
import { CURRENT_ASSESSMENT } from "../__fixtures__/current-assessments";
import { addAction, initialAdjudication, removeAddedAction, selectActionDraft, selectAudienceRows, selectDispositionChoice, selectSendability, setDisposition } from "./assessment-adjudication";

const builderAction = CURRENT_ASSESSMENT.next_actions.find(action => action.audience === "rework");
if (!builderAction) throw new Error("fixture has no builder action");
const source = { kind: "additional_finding" as const, id: "F-1" };
const dropAll = () => CURRENT_ASSESSMENT.next_actions.reduce((state, action) => setDisposition(state, action.id, { kind: "reject", reason: "" }), initialAdjudication(CURRENT_ASSESSMENT));

describe("removeAddedAction", () => {
  it("takes back an added builder action, so accept is sendable again", () => {
    const added = addAction(dropAll(), { audience: "rework", source, text: "Mistake." });
    const removed = removeAddedAction(added, added.added_actions[0]?.action_id ?? "");
    expect([selectSendability(added, "approve").kind, selectSendability(removed, "approve").kind]).toEqual(["blocked", "sendable"]);
  });
});

describe("action drafts", () => {
  it("restores the replacement text when switching Edit → Keep → Edit", () => {
    const edited = setDisposition(initialAdjudication(CURRENT_ASSESSMENT), builderAction.id, { kind: "edit", final_text: "Replacement" });
    const kept = setDisposition(edited, builderAction.id, { kind: "accept" });
    expect(selectDispositionChoice(selectActionDraft(kept, builderAction), "modified")).toEqual({ kind: "edit", final_text: "Replacement" });
  });
  it("restores the drop reason when switching Drop → Keep → Drop", () => {
    const dropped = setDisposition(initialAdjudication(CURRENT_ASSESSMENT), builderAction.id, { kind: "reject", reason: "Already done." });
    const kept = setDisposition(dropped, builderAction.id, { kind: "accept" });
    expect(selectDispositionChoice(selectActionDraft(kept, builderAction), "rejected")).toEqual({ kind: "reject", reason: "Already done." });
  });
  it("starts an edit from the assessor's words", () => {
    expect(selectDispositionChoice(selectActionDraft(initialAdjudication(CURRENT_ASSESSMENT), builderAction), "modified")).toEqual({ kind: "edit", final_text: builderAction.text });
  });
});

describe("selectAudienceRows", () => {
  it("counts an audience's assessor actions and its added ones together", () => {
    const state = addAction(initialAdjudication(CURRENT_ASSESSMENT), { audience: "rework", source, text: "Added." });
    const rows = selectAudienceRows({ assessment: CURRENT_ASSESSMENT, added_actions: state.added_actions, recorded: null }, "rework");
    expect([rows.proposed.length, rows.added.length, rows.count]).toEqual([1, 1, 2]);
  });
});
