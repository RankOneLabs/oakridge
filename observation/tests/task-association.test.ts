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
test("addresses establishes task association without propagation; derived_from and unresolved edges do not seed", () => {
  const relations = [edge("derived", "task", "derived_from", true), edge("addressed", "task", "addresses", true),
    edge("linked", "task", "assesses", true), edge("derived", "linked", "derived_from"), edge("addressed", "own", "addresses"),
    { ...edge("unresolved", "task", "assesses", true), unresolved_target_ref: "missing" }];
  expect(associateTask({ task_id, occurrences: ["own", "linked", "derived", "addressed", "unresolved"].map(occurrence), relations }).map((item) => String(item.occurrence_id)))
    .toEqual(["own", "addressed", "linked"]);
});
test("supersedes cycles terminate once per occurrence with shortest provenance in traversal order", () => {
  const relations = [edge("a", "task", "assesses", true), edge("b", "a", "supersedes"), edge("c", "b", "split_from"), edge("a", "c", "merged_from")];
  expect(associateTask({ task_id, occurrences: ["a", "b", "c"].map(occurrence), relations })).toEqual([
    { occurrence_id: "a" as ItemOccurrenceId, provenance: { kind: "relation", hops: [relations[0]] .map(({ relation_id, type, evidence_ref, asserted_by }) => ({ relation_id, type, evidence_ref, asserted_by })) } },
    { occurrence_id: "b" as ItemOccurrenceId, provenance: { kind: "relation", hops: relations.slice(0, 2).map(({ relation_id, type, evidence_ref, asserted_by }) => ({ relation_id, type, evidence_ref, asserted_by })) } },
    { occurrence_id: "c" as ItemOccurrenceId, provenance: { kind: "relation", hops: relations.slice(0, 3).map(({ relation_id, type, evidence_ref, asserted_by }) => ({ relation_id, type, evidence_ref, asserted_by })) } },
  ]);
});

test("several build items deduplicate a finding and a shared item reaches both tasks", () => {
  const items = ["B1", "B2", "finding"].map(occurrence);
  const relations = [edge("B1", "task", "addresses", true), edge("B2", "task", "addresses", true), edge("B1", "other", "addresses", true), edge("finding", "B1", "assesses"), edge("finding", "B2", "assesses")];
  expect(associateTask({ task_id, occurrences: items, relations }).map((item) => String(item.occurrence_id))).toEqual(["B1", "B2", "finding"]);
  expect(associateTask({ task_id: "other" as LogicalItemId, occurrences: items, relations }).map((item) => String(item.occurrence_id))).toEqual(["B1", "finding"]);
});

test("resolved_assesses derives only resolved direct and two-hop task subjects", async () => {
  const { gradingSubjects } = await import("../src/grading/evidence");
  const subject = { occurrence_id: "finding" as ItemOccurrenceId, json_pointer: "/findings/0", selected_value: { subjects: [{ kind: "build_item", id: "B1" }] } };
  const relations = [edge("finding", "B1", "assesses"), edge("B1", "task", "addresses", true), edge("B1", "other", "addresses", true), edge("finding", "task", "assesses", true),
    { ...edge("finding", "missing", "assesses"), unresolved_target_ref: "missing" }, edge("missing", "unrelated", "addresses", true)];
  expect(gradingSubjects({ occurrence: subject, scope: { scope: "per_task", task_source: "resolved_assesses" }, relations }).map((subject) => String(subject.task_id))).toEqual(["other", "task"]);
  expect(gradingSubjects({ occurrence: { ...subject, selected_value: { subjects: [] } }, scope: { scope: "per_task", task_source: "resolved_assesses" }, relations: [] })).toEqual([{ subject_occurrence_id: subject.occurrence_id, task_id: null }]);
  expect(gradingSubjects({ occurrence: { ...subject, occurrence_id: "B1" as ItemOccurrenceId, json_pointer: "/build_items/0", selected_value: { task_ids: ["task", "other"] } }, scope: { scope: "per_task", task_ids: "/task_ids" }, relations: relations.map((relation) => ({ ...relation, evidence_ref: relation.target_logical_item_id === "task" ? "/build_items/0/task_ids/0" : "/build_items/0/task_ids/1" })) }).map((subject) => String(subject.task_id))).toEqual(["other", "task"]);
});
