import { expect, test } from "vitest";
import { id, IMPLEMENTATION, item } from "../__fixtures__/grading";
import type { ObservationLineageEntry } from "../grading-contracts/grading/composite";
import { selectTaskLineageGroups } from "./task-lineage";

test("groups task definitions, plan contributions, build items, findings and unresolved associations by kind", () => {
  const entries: ObservationLineageEntry[] = [
    { kind: "occurrence", artifact_kind: "spec", item_kind: "task", revision_id: id("spec:1"), item_path: "/tasks/0", occurrence_id: id("task"), unit_id: null, is_current: true },
    ...["acceptance_entry", "build_item", "assessment_finding"].map((item_kind): ObservationLineageEntry => ({ kind: "contribution", item: item(IMPLEMENTATION, { item_kind }), provenance: { kind: "relation", hops: [] } })),
    { kind: "unresolved", item: item(IMPLEMENTATION, { item_kind: "build_item" }), relation_id: id("missing"), unresolved_target_ref: "T-missing", evidence_ref: "/task_ids/0" },
  ];
  const groups = selectTaskLineageGroups(entries);
  expect(groups.map((group) => [group.label, group.entries.length])).toEqual([["Task definition", 1], ["Plan contributions", 1], ["Brief build items", 2], ["Assessment findings", 1]]);
  expect(groups[2]?.entries[1]).toBe(entries[4]);
});
test("an assessment finding retains its explicit two-hop build-item association", () => {
  const entry: ObservationLineageEntry = { kind: "contribution", item: item(IMPLEMENTATION), provenance: { kind: "relation", hops: [
    { relation_id: id("assesses"), type: "assesses", evidence_ref: "/subjects/0", asserted_by: "producer_explicit" },
    { relation_id: id("contributes"), type: "addresses", evidence_ref: "/task_ids/0", asserted_by: "producer_explicit" },
  ] } };
  expect(selectTaskLineageGroups([entry])[0]?.entries).toEqual([entry]);
});
