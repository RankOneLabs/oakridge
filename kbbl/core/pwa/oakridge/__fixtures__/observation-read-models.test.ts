import { expect, test } from "vitest";
import { disagreementResponse, mergeLineageResponse, splitLineageResponse, unresolvedSummary } from "./observation-read-models";

test("split, reordered and unresolved relation targets retain their addresses", () => {
  expect(splitLineageResponse.relations.map((relation) => relation.type)).toEqual(["split_from", "derived_from", "assesses"]);
  expect(splitLineageResponse.unresolved[0]?.unresolved_target_ref).toBe("missing-target");
});
test("merged criterion retains both source relations", () => {
  expect(mergeLineageResponse.relations.map((relation) => relation.target_occurrence_id))
    .toEqual(["criterion-old-a", "criterion-old-b"]);
});
test("unresolved summary has no inferred grade", () => {
  expect([unresolvedSummary.resolution.kind, unresolvedSummary.grade.tag]).toEqual(["unresolved", "not_ingested"]);
});
test("grader disagreement preserves independent answers", () => {
  expect(disagreementResponse.items.map((item) => item.answer.value)).toEqual(["pass", "fail"]);
});
