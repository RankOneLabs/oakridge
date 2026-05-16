import { describe, expect, it } from "vitest";
import { liveValueAt } from "./liveness";
import type { AtomEdit } from "./types";

function makeEdit(anchor: string | null, newValue: string, id: string = crypto.randomUUID()): AtomEdit {
  return {
    id,
    target_type: "plan",
    target_id: "plan-1",
    anchor,
    prior_value: null,
    new_value: newValue,
    author: "bot",
    created_at: new Date().toISOString(),
  };
}

describe("liveValueAt", () => {
  it("returns asEmitted when there are no edits", () => {
    expect(liveValueAt([], "goal", "original")).toBe("original");
  });

  it("returns asEmitted when no edit matches the anchor", () => {
    const edits = [makeEdit("other", "irrelevant")];
    expect(liveValueAt(edits, "goal", "original")).toBe("original");
  });

  it("returns the most recent edit value for the anchor", () => {
    const edits = [
      makeEdit("goal", "first", "00000000-0000-0000-0000-000000000001"),
      makeEdit("goal", "second", "00000000-0000-0000-0000-000000000002"),
    ];
    expect(liveValueAt(edits, "goal", "original")).toBe("second");
  });

  it("returns the latest matching edit even when interspersed with other anchors", () => {
    const edits = [
      makeEdit("goal", "goal-v1"),
      makeEdit("notes", "notes-v1"),
      makeEdit("goal", "goal-v2"),
      makeEdit("notes", "notes-v2"),
    ];
    expect(liveValueAt(edits, "goal", "original")).toBe("goal-v2");
    expect(liveValueAt(edits, "notes", "original")).toBe("notes-v2");
  });

  it("handles null anchor (document-level edits)", () => {
    const edits = [makeEdit(null, "whole-doc")];
    expect(liveValueAt(edits, null, "original")).toBe("whole-doc");
  });

  it("null anchor does not match named anchors", () => {
    const edits = [makeEdit(null, "whole-doc")];
    expect(liveValueAt(edits, "goal", "original")).toBe("original");
  });
});
