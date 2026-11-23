import { expect, test } from "vitest";
import { id, IMPLEMENTATION, item } from "../__fixtures__/grading";
import type { ObservationLineageEntry } from "../grading-contracts/grading/composite";
import { selectRepositoryJudgments, selectRevisionDecisionRoles, selectTaskLineageGroups } from "./task-lineage";

test("groups task definitions, plan contributions, build items, findings and unresolved associations by kind", () => {
  const entries: ObservationLineageEntry[] = [
    { kind: "occurrence", artifact_kind: "spec", item_kind: "task", revision_id: id("spec:1"), item_path: "/tasks/0", occurrence_id: id("task"), unit_id: null, is_current: true },
    ...["acceptance_entry", "build_item", "assessment_finding"].map((item_kind): ObservationLineageEntry => ({ kind: "contribution", item: item(IMPLEMENTATION, { item_kind }), provenance: { kind: "relation", hops: [] } })),
    { kind: "unresolved", item: item(IMPLEMENTATION, { item_kind: "build_item" }), relation_id: id("missing"), unresolved_target_ref: "T-missing", evidence_ref: "/task_ids/0" },
  ];
  const groups = selectTaskLineageGroups(entries);
  expect(groups.map((group) => [group.label, group.entries.length])).toEqual([["task", 1], ["acceptance entry", 1], ["build item", 2], ["assessment finding", 1]]);
  expect(groups[2]?.entries[1]).toBe(entries[4]);
});
test("an assessment finding retains its explicit two-hop build-item association", () => {
  const entry: ObservationLineageEntry = { kind: "contribution", item: item(IMPLEMENTATION), provenance: { kind: "relation", hops: [
    { relation_id: id("assesses"), type: "assesses", evidence_ref: "/subjects/0", asserted_by: "producer_explicit" },
    { relation_id: id("contributes"), type: "addresses", evidence_ref: "/task_ids/0", asserted_by: "producer_explicit" },
  ] } };
  expect(selectTaskLineageGroups([entry])[0]?.entries).toEqual([entry]);
});

const recorded = {
  id: "decision", decision_id: "decision", review: "appraisal_desk", decision: "endorse", effect: "approve" as const,
  actor: null, reviewed_revision_id: "folio:1", approved_assessment_revision_id: "appraisal:1",
  effect_target_revision_id: "appendix:1", target_revision_id: "appendix:1", payload: {}, created_at: "2026-11-01",
};

test("records three exact revision roles and ignores similar ids", () => {
  expect(["folio:1", "appraisal:1", "appendix:1", "folio:10"].map((revision) =>
    selectRevisionDecisionRoles(revision, [recorded]).map((result) => result.role),
  )).toEqual([["reviewed"], ["assessment approved"], ["effect target"], []]);
});

test("judgments stay pending without an approval for the same assessment revision", () => {
  const rows = selectRepositoryJudgments([
    { repository_key: "first", judgments: [{ assessment_revision_id: id("appraisal:2"), status: "partial" }] },
    { repository_key: "second", judgments: [{ assessment_revision_id: id("appraisal:1"), status: "met" }] },
  ], [recorded]);
  expect(rows.map(({ status }) => status)).toEqual(["pending", "met"]);
});

test("the latest published assessment wins even when the older assessment was approved last", () => {
  const rows = selectRepositoryJudgments([{ repository_key: "first", judgments: [
    { assessment_revision_id: id("appraisal:9"), status: "partial" },
    { assessment_revision_id: id("appraisal:10"), status: "met" },
    { assessment_revision_id: id("appraisal:11"), status: "not_met" },
  ] }], [
    { ...recorded, approved_assessment_revision_id: "appraisal:10", created_at: "2026-11-01" },
    { ...recorded, approved_assessment_revision_id: "appraisal:9", created_at: "2026-11-02" },
  ]);
  expect(rows).toEqual([{ repository_key: "first", status: "met" }]);
});
