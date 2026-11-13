import { sampleCohort, withUnitFields } from "../__fixtures__/read-models";
import { expect, test } from "vitest";
import type { OperatorArtifactRevisionView } from "../operator-contracts/projections/unit-view";
import type { ObservationAddressedItem, ObservationLogicalLinkRead } from "../grading-contracts/grading/item-reads";
import { artifactRevisionIdOf } from "./grading-ids";
import { selectDependencyLinks, selectGradingSubjectLink, selectInputRevisionIds, selectIntentLinks, selectRevisionRelationships, selectTaskAssociationLink, type RelationshipIndex } from "./recorded-relationships";
const revision = { id: "old-revision", run_id: "run", unit_id: "upstream", artifact_key: "document", number: 1, predecessor_id: null, subject_id: null } as OperatorArtifactRevisionView;
const upstream = withUnitFields(sampleCohort, { run_id: "run", unit_id: "upstream" });
const recordedAttempt = sampleCohort.attempts[0];
if (!recordedAttempt) throw new Error("captured cohort requires an attempt");
const unit = withUnitFields(sampleCohort, { run_id: "run", unit_id: "downstream", depends_on: ["upstream", "missing"], attempts: [{ ...recordedAttempt, id: "attempt", worker: "author", number: 1,
  intent: { inputs: { source: { revision_id: revision.id } }, engine_inputs: { previous: null, feedback: [], subject: null }, prompt: null } }] });
const index: RelationshipIndex = { run_id: "run", units: [unit, upstream], revisions: [revision] };
test("dependencies resolve only by recorded unit ids", () => {
  expect(selectDependencyLinks(index, unit).map((link) => link.resolution.state)).toEqual(["resolved", "unresolved"]);
});
test("intent revision links open the exact earlier revision and owning artifact", () => {
  const link = selectIntentLinks(index, unit)[0];
  expect(link?.resolution.state === "resolved" ? link.resolution.target.pane : null).toEqual({ kind: "artifact", artifact_id: "v2|artifact|run|upstream|document", revision_id: "old-revision", run_id: "run", unit_id: "upstream" });
});
test("revision predecessor and review subject ids stay distinct", () => {
  expect(selectRevisionRelationships(index, { ...revision, predecessor_id: "missing", subject_id: "old-revision" }).map((link) => [link.kind, link.raw_reference, link.resolution.state])).toEqual([
    ["revision_predecessor", "missing", "unresolved"], ["revision_subject", "old-revision", "resolved"]]);
});
test("null provenance is not captured and is never silently dropped", () => {
  expect(selectRevisionRelationships(index, revision).map((link) => link.resolution.state)).toEqual(["not_captured", "not_captured"]);
});
test("names, arbitrary ids, text and timestamps never create revision relationships", () => {
  expect(selectInputRevisionIds({ id: "old-revision", name: "document", text: "old-revision", created_at: "old-revision" })).toEqual([]);
});
test("RevisionState and explicit revision_id references are supported without traversing artifact bodies", () => {
  expect(selectInputRevisionIds({ id: "r", unit: "u", artifact: "a", body: { revision_id: "fake" } })).toEqual(["r"]);
});
test("a grading subject preserves occurrence, exact revision, item path and question", () => {
  const item = { source_revision_id: artifactRevisionIdOf(revision.id), unit_id: "upstream", item_path: "/findings/2", occurrence_id: "occ-2" } as ObservationAddressedItem;
  const question = { question_id: "correctness", question_version: "v2" } as import("../grading-contracts/grading/question").ObservationQuestionKey;
  const link = selectGradingSubjectLink(index, { item, question });
  expect(link.resolution.state === "resolved" ? link.resolution.target.pane : null).toMatchObject({ kind: "item", selection: { source_revision_id: "old-revision", item_path: "/findings/2" }, subject_occurrence_id: "occ-2", question });
});
test("recorded task associations resolve and unresolved task refs stay non-openable", () => {
  const resolved = { state: "resolved", producer_local_id: "task-4", logical_item_id: "logical-4" } as ObservationLogicalLinkRead;
  const unresolved = { state: "unresolved", producer_local_id: "task-4", unresolved_target_ref: "missing-task" } as ObservationLogicalLinkRead;
  expect([selectTaskAssociationLink(index, { link: resolved }), selectTaskAssociationLink(index, { link: unresolved })].map((link) => link.resolution.state === "resolved" ? link.resolution.target.pane : link.raw_reference)).toEqual([{ kind: "task", task_id: "task-4" }, "missing-task"]);
});
