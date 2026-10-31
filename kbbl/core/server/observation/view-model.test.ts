import { expect, test } from "bun:test";
import { gradeSlot, type GradeSlot } from "./view-model";

const tags: readonly GradeSlot["tag"][] = ["not_ingested", "loading", "unavailable", "unauthorized", "stale",
  "inapplicable", "missing_evidence", "queued", "running", "failed", "no_eligible_question", "ready"];
for (const tag of tags) test(`grade slot ${tag}`, () => {
  const result = gradeSlot({ state: tag, current_revision_id: "same", occurrence_revision_id: "same", observations: [] });
  expect(result.ok && result.value.tag).toBe(tag);
});
test("staleness compares revision identity, independent of projection lag", () => {
  const current = gradeSlot({ state: "ready", current_revision_id: "a", occurrence_revision_id: "a", observations: [] });
  const changed = gradeSlot({ state: "ready", current_revision_id: "b", occurrence_revision_id: "a", observations: [] });
  expect([current.ok && current.value.tag, changed.ok && changed.value.tag]).toEqual(["ready", "stale"]);
});
