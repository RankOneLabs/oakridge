import { describe, expect, it } from "vitest";
import { specDiff } from "./spec-diff";

describe("specDiff", () => {
  it("shows the retained context around an approved change", () => {
    expect(specDiff("Goal\nOld rule\nDone", "Goal\nNew rule\nDone")).toEqual([
      { kind: "same", text: "Goal" },
      { kind: "removed", text: "Old rule" },
      { kind: "added", text: "New rule" },
      { kind: "same", text: "Done" },
    ]);
  });
});
