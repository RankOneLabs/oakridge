import { expect, test } from "bun:test";
import type { ItemOccurrenceId, LogicalItemId, RelationId } from "../src/domain/identity";
import type { CompositeRelation } from "../src/grading/composite";
import { associateTask } from "../src/grading/task-association";

const task_id = "task" as LogicalItemId;
const occurrence = (id: string) => ({ occurrence_id: id as ItemOccurrenceId, logical_item_id: id === "own" ? task_id : null });
function edge(source: string, target: string, type: CompositeRelation["type"], logical = false): CompositeRelation {
  return { relation_id: `${source}-${target}` as RelationId, source_occurrence_id: source as ItemOccurrenceId,
    target_occurrence_id: logical ? null : target as ItemOccurrenceId, target_logical_item_id: logical ? target as LogicalItemId : null,
    type, unresolved_target_ref: null, evidence_ref: "field", asserted_by: "producer_explicit" };
}
test("derived_from and addresses never establish or propagate task association; unresolved edges do not seed", () => {
  const relations = [edge("derived", "task", "derived_from", true), edge("addressed", "task", "addresses", true),
    edge("linked", "task", "assesses", true), edge("derived", "linked", "derived_from"), edge("addressed", "own", "addresses"),
    { ...edge("unresolved", "task", "assesses", true), unresolved_target_ref: "missing" }];
  expect(associateTask({ task_id, occurrences: ["own", "linked", "derived", "addressed", "unresolved"].map(occurrence), relations }).map((item) => String(item.occurrence_id)))
    .toEqual(["own", "linked"]);
});
test("supersedes cycles terminate once per occurrence with shortest provenance in traversal order", () => {
  const relations = [edge("a", "task", "assesses", true), edge("b", "a", "supersedes"), edge("c", "b", "split_from"), edge("a", "c", "merged_from")];
  expect(associateTask({ task_id, occurrences: ["a", "b", "c"].map(occurrence), relations })).toEqual([
    { occurrence_id: "a" as ItemOccurrenceId, provenance: { kind: "relation", hops: [relations[0]] .map(({ relation_id, type, evidence_ref, asserted_by }) => ({ relation_id, type, evidence_ref, asserted_by })) } },
    { occurrence_id: "b" as ItemOccurrenceId, provenance: { kind: "relation", hops: relations.slice(0, 2).map(({ relation_id, type, evidence_ref, asserted_by }) => ({ relation_id, type, evidence_ref, asserted_by })) } },
    { occurrence_id: "c" as ItemOccurrenceId, provenance: { kind: "relation", hops: relations.slice(0, 3).map(({ relation_id, type, evidence_ref, asserted_by }) => ({ relation_id, type, evidence_ref, asserted_by })) } },
  ]);
});
