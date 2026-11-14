import { expect, test } from "vitest";
import { selectHandoffBrief } from "./handoff-provenance";
import brief from "./__fixtures__/build-items-brief.json";
const attempt = { intent: { input_provenance: { status: "recorded" as const, entries: [{ input: "brief", unit: "briefs/cohort", revision_id: "original" }] }, inputs: null, engine_inputs: { previous: null, subject: null, feedback: [] }, prompt: null } };
test("reads build ids from the exact recorded revision even after a later brief", () => {
  expect(selectHandoffBrief(attempt, [{ id: "original", unit_id: "briefs/cohort", body: brief }, { id: "later", unit_id: "briefs/cohort", body: { ...brief, build_items: [] } }])).toEqual({ revision_id: "original", build_item_ids: ["B1"] });
});
test("missing original content never falls back to a later revision", () => {
  expect(selectHandoffBrief(attempt, [{ id: "later", unit_id: "briefs/cohort", body: brief }])).toEqual({ revision_id: "original", build_item_ids: null });
});
test("missing provenance stays unresolved", () => {
  expect(selectHandoffBrief(null, [])).toEqual({ revision_id: null, build_item_ids: null });
});
