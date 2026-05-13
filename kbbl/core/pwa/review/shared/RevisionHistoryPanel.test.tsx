import { describe, test, expect } from "bun:test";
import { filterHistoryByAnchor } from "./useArtifactStream";
import type { AtomEditRecord } from "./types";

function makeEdit(overrides: Partial<AtomEditRecord> = {}): AtomEditRecord {
  return {
    id: "edit-1",
    target_type: "plan",
    target_id: "plan-abc",
    anchor: "cohorts[0].title",
    prev_value: null,
    new_value: "My cohort",
    edited_by: "operator",
    thread_id: null,
    created_at: "2026-05-13T00:00:00Z",
    ...overrides,
  };
}

describe("filterHistoryByAnchor", () => {
  test("returns all edits when anchor is null", () => {
    const edits = [
      makeEdit({ anchor: "cohorts[0].title" }),
      makeEdit({ anchor: "cohorts[1].title", id: "edit-2" }),
    ];
    expect(filterHistoryByAnchor(edits, null)).toHaveLength(2);
  });

  test("filters edits by exact anchor match", () => {
    const edits = [
      makeEdit({ anchor: "cohorts[0].title", id: "edit-1" }),
      makeEdit({ anchor: "cohorts[1].title", id: "edit-2" }),
      makeEdit({ anchor: "cohorts[0].notes", id: "edit-3" }),
    ];
    const result = filterHistoryByAnchor(edits, "cohorts[0].title");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("edit-1");
  });

  test("returns empty array when no edits match the anchor", () => {
    const edits = [makeEdit({ anchor: "cohorts[0].title" })];
    expect(filterHistoryByAnchor(edits, "cohorts[99].title")).toHaveLength(0);
  });

  test("returns empty array on empty input", () => {
    expect(filterHistoryByAnchor([], "cohorts[0].title")).toHaveLength(0);
    expect(filterHistoryByAnchor([], null)).toHaveLength(0);
  });

  test("anchor-scoped filter does not include prefix-matching anchors", () => {
    const edits = [
      makeEdit({ anchor: "cohorts[0]", id: "edit-1" }),
      makeEdit({ anchor: "cohorts[0].title", id: "edit-2" }),
      makeEdit({ anchor: "cohorts[0].notes", id: "edit-3" }),
    ];
    const result = filterHistoryByAnchor(edits, "cohorts[0]");
    // exact match only — not prefix
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("edit-1");
  });
});
