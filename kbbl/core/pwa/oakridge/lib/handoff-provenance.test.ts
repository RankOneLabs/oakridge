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

import { selectHandoffContext, selectHandoffRevisionId, selectHandoffUnit, selectHandoffBriefUnit, selectHandoffUnitId, selectHandoffProvenance } from "./handoff-provenance";
import { sampleUnits } from "../__fixtures__/read-models";
import captured from "../__fixtures__/v2-adapter-sample.json";
import type { OperatorArtifactDetail } from "../operator-contracts/projections/artifact-view";
const history = captured.artifact as unknown as OperatorArtifactDetail;
const owner = sampleUnits.find((unit) => unit.unit_id === history.unit_id);
const revision = history.revisions[0];
const template = owner?.attempts[0];
if (!owner || !revision || !template) throw new Error("captured handoff needs a revision and attempt");
const builder = { ...template, id: "builder", worker: "builder", intent: attempt.intent };
const assessor = { ...template, id: "assessor", worker: "assessor", intent: attempt.intent };
const unit = { ...owner, attempts: [builder, assessor] };
const revisions = [{ ...revision, id: "assessment", attempt_id: assessor.id, subject_id: "result" }, { ...revision, id: "result", attempt_id: builder.id }];
test("composite assessment identity finds the recorded assessor and builder through its subject", () => {
  expect(selectHandoffContext({ unit, revisions, revisionId: `v2|artifact|${unit.run_id}|${unit.unit_id}|assessment:assessment` })).toEqual({ builder, assessor, resultId: "result" });
});
test("unknown revisions never select a current attempt", () => {
  expect(selectHandoffContext({ unit, revisions, revisionId: "unknown" })).toEqual({ builder: null, assessor: null, resultId: null });
});
test("attempt inspection selects its exact recorded brief unit", () => {
  const context = selectHandoffContext({ unit, revisions, attemptId: "builder" });
  expect(selectHandoffBriefUnit(context.builder)).toBe("briefs/cohort");
});
test("raw revision ids and absent ids keep their identity", () => {
  expect([selectHandoffRevisionId("raw"), selectHandoffRevisionId(undefined)]).toEqual(["raw", null]);
});
test("unit lookup keeps missing provenance unresolved", () => {
  expect(selectHandoffUnit(sampleUnits, null)).toBeNull();
});
test("an assessment pane's revision names its owning unit, not its cohort label", () => {
  expect([selectHandoffUnitId(`v2|artifact|${unit.run_id}|${encodeURIComponent(unit.unit_id)}|assessment:assessment`), selectHandoffUnitId("raw")]).toEqual([unit.unit_id, null]);
});
test("provenance resolves each worker's brief from either brief unit and indexes every revision", () => {
  const briefRevision = { ...revision, id: "original", unit_id: "briefs/cohort", body: brief };
  const provenance = selectHandoffProvenance({ run_id: unit.run_id, units: [unit], builder, assessor, unit_revisions: revisions, builder_brief_revisions: [briefRevision], assessor_brief_revisions: [] });
  expect([provenance.builder_brief, provenance.assessor_brief, provenance.index.revisions.map((candidate) => candidate.id)])
    .toEqual([{ revision_id: "original", build_item_ids: ["B1"] }, { revision_id: "original", build_item_ids: ["B1"] }, ["original", "assessment", "result"]]);
});
