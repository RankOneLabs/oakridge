import { describe, expect, it } from "vitest";
import { makeInboxCommand, makeInboxDiagnostic, makeInboxWait } from "../__fixtures__/read-models";
import { selectAttentionCount, selectRunAttentionCounts } from "./run-attention";

describe("run attention counts", () => {
  it("groups actionable commands by run", () => {
    const counts = selectRunAttentionCounts([
      makeInboxCommand({ run_id: "run-a", scope_id: "scope-1" }),
      makeInboxCommand({ run_id: "run-a", scope_id: "scope-2" }),
      makeInboxCommand({ run_id: "run-b" }),
    ]);
    expect([...counts]).toEqual([["run-a", 2], ["run-b", 1]]);
  });

  it("does not treat a downstream wait as operator attention", () => {
    const counts = selectRunAttentionCounts([makeInboxWait({ run_id: "run-a" })]);
    expect(counts.get("run-a")).toBeUndefined();
  });

  it("counts a projected diagnostic as run attention", () => {
    const counts = selectRunAttentionCounts([makeInboxDiagnostic({ run_id: "run-a" })]);
    expect(counts.get("run-a")).toBe(1);
  });

  it("keeps the command-only toolbar badge distinct from diagnostic attention", () => {
    expect(selectAttentionCount([makeInboxCommand(), makeInboxDiagnostic()])).toBe(1);
  });
});
