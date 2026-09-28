import { describe, expect, it } from "vitest";

import { selectStableDecisionQueue, type DecisionQueueEntry } from "./decision-queue";
import type { ReviewInboxItem } from "../types";

function gate(id: string): ReviewInboxItem {
  return { id, kind: "artifact_gate", state: "actionable", run_id: "run-1", workflow_name: "dev_flow_v14", stage_instance_id: "stage", stage_name: "brief_writer",
    unit_id: id, lifecycle: "artifact_review", artifact_revision_id: `revision-${id}`, gate_id: id, resume_actions: ["approve", "request_revision"], blocked_by: [] };
}

const live = (id: string): DecisionQueueEntry => ({ kind: "live", item: gate(id) });

describe("selectStableDecisionQueue", () => {
  it("keeps a departed item in its place as settled so the rows below do not move", () => {
    expect(selectStableDecisionQueue([live("a"), live("b"), live("c")], [gate("b"), gate("c")]))
      .toEqual([{ kind: "settled", item: gate("a") }, live("b"), live("c")]);
  });

  it("appends newly arrived work after the existing rows, even when the server lists it first", () => {
    expect(selectStableDecisionQueue([live("a"), live("b")], [gate("assessment"), gate("a"), gate("b")]))
      .toEqual([live("a"), live("b"), live("assessment")]);
  });

  it("starts from the server order when nothing was on screen", () => {
    expect(selectStableDecisionQueue([], [gate("b"), gate("a")])).toEqual([live("b"), live("a")]);
  });
});
