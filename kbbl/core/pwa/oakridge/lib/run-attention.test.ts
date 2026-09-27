import { describe, expect, it } from "vitest";

import type { ReviewInboxItem } from "../types";
import { selectRunAttentionCounts } from "./run-attention";

function inboxItem(
  id: string,
  runId: string,
  state: ReviewInboxItem["state"],
  blockedBy: string[] = [],
  kind: ReviewInboxItem["kind"] = "cohort_blocked",
): ReviewInboxItem {
  return {
    id,
    kind,
    state,
    run_id: runId,
    workflow_name: "spec_to_ship",
    stage_instance_id: "stage-1",
    stage_name: "build",
    unit_id: "unit-1",
    lifecycle: "building",
    resume_actions: [],
    blocked_by: blockedBy,
  };
}

describe("selectRunAttentionCounts", () => {
  it("groups actionable items by run", () => {
    const counts = selectRunAttentionCounts([
      inboxItem("one", "run-a", "actionable"),
      inboxItem("two", "run-a", "actionable"),
      inboxItem("three", "run-b", "actionable"),
    ]);

    expect([...counts]).toEqual([["run-a", 2], ["run-b", 1]]);
  });

  it("does not treat a downstream handoff wait as attention", () => {
    const counts = selectRunAttentionCounts([
      inboxItem("wait", "run-a", "blocked", ["handoff_downstream"]),
    ]);

    expect(counts.get("run-a")).toBeUndefined();
  });

  it("counts a pull request mismatch even when its backend state is blocked", () => {
    const counts = selectRunAttentionCounts([
      inboxItem("mismatch", "run-a", "blocked", [], "pull_request_mismatch"),
    ]);

    expect(counts.get("run-a")).toBe(1);
  });
});
