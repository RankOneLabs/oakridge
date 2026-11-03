import { describe, expect, it } from "vitest";
import sample from "../__fixtures__/v2-adapter-sample.json";
import { withUnitFields } from "../__fixtures__/read-models";
import type { OperatorRevisionDecision, OperatorUnitView } from "../operator-contracts";
import { sentReviewFeedback } from "./core";

const cohort: OperatorUnitView = (() => {
  const selected = (sample.units as unknown as OperatorUnitView[])
    .find((unit) => unit.stage === "cohort" && unit.artifacts.some((artifact) => artifact.artifact_key === "assessment" && artifact.latest_revision));
  if (!selected) throw new Error("captured fixture lacks a cohort with an assessment");
  return selected;
})();
const assessment = cohort.artifacts.find((artifact) => artifact.artifact_key === "assessment")?.latest_revision;
if (!assessment) throw new Error("captured fixture lacks an assessment revision");

const decided = (id: string, fields: Partial<OperatorRevisionDecision> = {}): OperatorRevisionDecision => ({
  id, review: "assessment_review", decision: "request_assessment_changes", effect: "request_changes",
  target_revision_id: assessment.id, payload: { feedback: "Check the migration path." }, created_at: "2026-10-28T12:00:00Z", ...fields });

const withDecisions = (...recorded_decisions: OperatorRevisionDecision[]) => withUnitFields(cohort, { recorded_decisions });

describe("sentReviewFeedback", () => {
  it("lists requested changes on the latest revision, with the feedback and who it went to", () => {
    expect(sentReviewFeedback(withDecisions(decided("d1")))).toEqual([{
      id: "d1", target_revision_id: assessment.id,
      run_id: cohort.run_id, stage_name: "assessment", unit_id: cohort.collection_key, review: "assessment_review",
      decision: "request_assessment_changes", feedback: "Check the migration path.", sent_at: "2026-10-28T12:00:00Z" }]);
  });

  it("drops requested changes once a newer revision replaces their target", () => {
    expect(sentReviewFeedback(withDecisions(decided("d1", { target_revision_id: `${cohort.unit_id}:assessment:0` })))).toEqual([]);
  });

  it("drops requested changes a later decision on the same revision overrides", () => {
    expect(sentReviewFeedback(withDecisions(decided("d1"), decided("d2", { decision: "accept", effect: "approve", payload: {} })))).toEqual([]);
  });

  it("does not list an approval", () => {
    expect(sentReviewFeedback(withDecisions(decided("d1", { decision: "accept", effect: "approve", payload: {} })))).toEqual([]);
  });

  it("leaves feedback empty when the decision carried none", () => {
    expect(sentReviewFeedback(withDecisions(decided("d1", { payload: {} })))[0].feedback).toBeNull();
  });
});
