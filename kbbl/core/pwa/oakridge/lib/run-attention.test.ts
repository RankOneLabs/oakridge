import { describe, expect, it } from "vitest";
import { makeInboxDecision, makeInboxStalled, makeInboxWaiting } from "../__fixtures__/read-models";
import { selectAttentionCount, selectRunAttentionCounts } from "./run-attention";

describe("run attention counts", () => {
  it("groups actionable decisions by run", () => {
    const counts = selectRunAttentionCounts([
      makeInboxDecision({ run_id: "run-a", unit_id: "unit-1" }),
      makeInboxDecision({ run_id: "run-a", unit_id: "unit-2" }),
      makeInboxDecision({ run_id: "run-b" }),
    ]);
    expect([...counts]).toEqual([["run-a", 2], ["run-b", 1]]);
  });

  it("does not treat a downstream wait as operator attention", () => {
    const counts = selectRunAttentionCounts([makeInboxWaiting({ run_id: "run-a" })]);
    expect(counts.get("run-a")).toBeUndefined();
  });

  it("counts a projected diagnostic as run attention", () => {
    const counts = selectRunAttentionCounts([makeInboxStalled({ run_id: "run-a" })]);
    expect(counts.get("run-a")).toBe(1);
  });

  it("keeps the decision-only toolbar badge distinct from diagnostic attention", () => {
    expect(selectAttentionCount([makeInboxDecision(), makeInboxStalled()])).toBe(1);
  });
});
