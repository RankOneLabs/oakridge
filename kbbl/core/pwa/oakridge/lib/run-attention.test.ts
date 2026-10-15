import { describe, expect, it } from "vitest";
import { makeInboxDecision, makeInboxStalled, makeInboxWaiting } from "../__fixtures__/read-models";
import { selectRunAttention } from "./run-attention";

describe("run attention", () => {
  it("counts two asks on one unit in the list, header, badge and sidebar shape", () => {
    const attention = selectRunAttention([
      makeInboxDecision({ run_id: "run-a", unit_id: "unit-1", key: "approve" }),
      makeInboxDecision({ run_id: "run-a", unit_id: "unit-1", key: "request_changes" }),
    ]);
    expect({ list: attention.count, header: attention.count, badge: attention.decision_count,
      sidebar: attention.by_unit.get("unit-1") }).toEqual({ list: 2, header: 2, badge: 2, sidebar: 2 });
  });

  it("excludes waits and includes projected diagnostics", () => {
    const attention = selectRunAttention([makeInboxWaiting(), makeInboxStalled()]);
    expect({ count: attention.count, decisions: attention.decision_count }).toEqual({ count: 1, decisions: 0 });
  });
});
