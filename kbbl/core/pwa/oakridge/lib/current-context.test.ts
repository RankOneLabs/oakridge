import { expect, test } from "vitest";
import { selectConsumedAnalysisRevisionId } from "./current-context";
const original = { requirements: [{ id: "R1", text: "Old", source_refs: [], findings: [] }] };
const revised = { requirements: [{ id: "R1", text: "New", source_refs: [], findings: [] }] };
const unrecorded = { status: "recorded" as const, entries: [] };
test("a recorded approved_analysis input names the exact revision", () => {
  const provenance = { status: "recorded" as const, entries: [{ input: "approved_analysis", unit: "analysis", revision_id: "analysis:1" }] };
  expect(selectConsumedAnalysisRevisionId({ provenance, consumed: original, approvedLatest: { id: "analysis:2", body: revised } })).toBe("analysis:1");
});
test("an older spec's saved analysis never opens a newer analysis revision", () => {
  expect(selectConsumedAnalysisRevisionId({ provenance: unrecorded, consumed: original, approvedLatest: { id: "analysis:2", body: revised } })).toBeNull();
});
test("a saved analysis equal to the latest approved revision names it, whatever its key order", () => {
  const reordered = { requirements: [{ findings: [], source_refs: [], text: "Old", id: "R1" }] };
  expect(selectConsumedAnalysisRevisionId({ provenance: unrecorded, consumed: reordered, approvedLatest: { id: "analysis:1", body: original } })).toBe("analysis:1");
});
test("without a saved analysis the approved latest revision is the one shown", () => {
  expect(selectConsumedAnalysisRevisionId({ provenance: null, consumed: undefined, approvedLatest: { id: "analysis:1", body: original } })).toBe("analysis:1");
});
test("an unapproved latest analysis is never linked", () => {
  expect(selectConsumedAnalysisRevisionId({ provenance: null, consumed: undefined, approvedLatest: null })).toBeNull();
});
