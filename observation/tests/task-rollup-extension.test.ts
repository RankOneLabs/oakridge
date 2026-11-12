import { expect, test } from "bun:test";
import { selectComposite, selectDrilldown, uniformDrilldownPages } from "../src/grading/composite";
import { stagesFromReadiness } from "../src/grading/task-stages";
import { selectRevision, type ExtractorDefinition } from "../src/projection/extractor";
import { oakridgeProfile } from "../src/producers/oakridge/profile";
import { all, answer, evidence, grader, inputs, occurrence, question, revision, task } from "./rollup-fixture";

const extension: ExtractorDefinition = { artifact_kind: "audit-note", schema_version: "1", extractor_id: "fixture.audit", extractor_version: "1", item_kind: "audit-entry", item_selector: "/items/*",
  select: () => ({ ok: true, value: [10, 2].map((number) => ({ item_kind: "audit-entry", item_selector: "/items/*", item_id_or_path: `/items/${number}`,
    path: `/items/${number}`, item_scope: "task", producer_local_id: "T1", selected_value: number, links: [] })) }) };
test("a profile's new extractor and readiness stage appear in dependency order without a roll-up edit", () => {
  const original = oakridgeProfile([]);
  const profile = { ...original, extraction: { ...original.extraction, definitions: (kind: string, version: string) => kind === extension.artifact_kind ? [extension] : original.extraction.definitions(kind, version) } };
  const audit = revision("audit-1", "compliance_audit", "audit-note");
  const selected = selectRevision({}, audit.revision_id, profile.extraction.definitions("audit-note", "1"));
  const items = selected.items.map(({ item }) => ({ ...occurrence(item.path, audit, task, item.path), item_kind: item.item_kind, selected_value: item.selected_value }));
  const sets = items.map((item) => evidence(item, task));
  const snapshot = inputs({ stages: stagesFromReadiness([
    { unit_id: "audit", stage: "compliance_audit", depends_on: ["start"], status: { kind: "done" }, artifacts: [{ artifact_key: "audit-note" }] },
    { unit_id: "start", stage: "discovery", depends_on: [], status: { kind: "done" }, artifacts: [{ artifact_key: "memo" }] },
    { unit_id: "last", stage: "release", depends_on: ["audit"], status: { kind: "not_started" }, artifacts: [{ artifact_key: "audit-note" }] }
  ]), pins: [{ ...question, scope: "per_task", task_ids: "/task_ids", artifact_kind: "audit-note", item_selector: extension.item_selector, item_kind: extension.item_kind, evaluator_definition_ids: [grader] }],
    revisions: [audit, revision("old-capture", "retired_stage")], occurrences: items, evidence_sets: sets, answers: sets.map(answer) });
  const rollup = selectComposite(snapshot, profile.composite, snapshot.logical_items[0]!);
  expect(rollup.stages.map((stage) => [stage.stage, stage.state])).toEqual([
    ["discovery", "not_graded"], ["compliance_audit", "linked"], ["release", "pending"], ["retired_stage", "not_graded"]
  ]);
  const stage = rollup.stages[1]!;
  expect(stage.results.map((result) => result.item.item_path)).toEqual(["/items/2", "/items/10"]);
  expect(stage.publication).toMatchObject({ state: "published", is_final: false });
  const drill = selectDrilldown(snapshot, profile.composite, stage.items, uniformDrilldownPages(all));
  expect(drill.items.map((row) => row.item.item_path)).toEqual(["/items/2", "/items/10"]);
  const last = selectComposite({ ...snapshot, revisions: [...snapshot.revisions, revision("release-1", "release", "audit-note")] }, profile.composite, snapshot.logical_items[0]!);
  expect(last.stages[2]).toMatchObject({ state: "gap", publication: { state: "published", is_final: true } });
  expect(last.stages[3]?.publication).toMatchObject({ is_final: false });
});
