import { expect, test } from "bun:test";
import type { ParsedWorkflow } from "../src/core-client/core-types";
import type { UnitId } from "../src/domain/primitives";
import { selectOperatorActions } from "../src/projections/operator-actions";
import type { RunRead } from "../src/storage/read-store";
import { validAdjudication } from "./adjudication-fixture";

const workflow: ParsedWorkflow = {
  workflow: "history",
  input: { kind: "text" },
  run: { units: {}, outcome: {} },
  stages: { cohort: {
    input: { kind: "record", fields: {} }, artifacts: {}, workers: {}, outcome: {},
    reviews: { assessment_review: {
      by: "operator", of: "assessment", assessment: "assessment",
      decisions: {
        request_build_changes: { effect: "request_changes", label: "Rebuild", adjudication: "feedback", on: "build_result" },
        request_assessment_changes: { effect: "request_changes", label: "Reassess" },
      },
    } },
  } },
};
const created_at = new Date("2026-01-01T00:00:01Z");
const actor = { kind: "operator", subject: "reviewer" } as const;
const unit_id = "run/cohort" as UnitId;
const payload = validAdjudication();
const recorded = {
  id: "decision-2", unit_id, review: "assessment_review", decision: "request_build_changes", effect: "request_changes",
  target_revision_id: "build", payload, actor, created_at,
};
const readWithDecisions = (decisions: readonly (typeof recorded)[]): RunRead => ({
  definition: { parsed_workflow: workflow },
  units: [{ id: unit_id, stage: "cohort" }],
  revisions: [
    { id: "build", unit_id, artifact: "build_result", seq: 1, created_at: new Date(0) },
    { id: "assessment", unit_id, artifact: "assessment", seq: 1, created_at: new Date(0) },
    { id: "later-assessment", unit_id, artifact: "assessment", seq: 2, created_at: new Date("2026-01-02") },
  ],
  decisions,
}) as unknown as RunRead;

test("history includes only operator actions on recorded adjudications", () => {
  const plain = { ...recorded, id: "decision-1", decision: "request_assessment_changes" };
  const context = { unit_id, assessment_revision_id: "assessment", review: "assessment_review",
    decision: "request_build_changes", decision_id: recorded.id, actor, created_at };
  const source = { kind: "item_assessment", id: "B1" } as const;
  expect(selectOperatorActions(readWithDecisions([recorded, plain]))).toEqual([
    { ...context, kind: "assessed", action_id: payload.entries[3].action_id, disposition: "accepted", original_text: "operator", final_text: null, source, reason: null },
    { ...context, kind: "assessed", action_id: payload.entries[4].action_id, disposition: "modified", original_text: "operator modified", final_text: "replacement", source, reason: null },
    { ...context, kind: "assessed", action_id: payload.entries[5].action_id, disposition: "rejected", original_text: "operator rejected", final_text: null, source, reason: null },
    { ...context, kind: "added", action_id: payload.added_actions[1].action_id, final_text: "added", source: { kind: "additional_finding", id: "F1" }, reason: null },
  ]);
});

test("history orders decisions by time then id and preserves payload order within each decision", () => {
  const oldest = { ...recorded, id: "decision-3", created_at: new Date("2026-01-01") };
  const tied = { ...recorded, id: "decision-1" };
  expect(selectOperatorActions(readWithDecisions([recorded, oldest, tied])).map(entry => entry.decision_id))
    .toEqual([oldest.id, tied.id, recorded.id].flatMap(id => Array<string>(4).fill(id)));
});
