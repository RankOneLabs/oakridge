import { createApp } from "../src/http/app";
import { withTenant } from "../src/storage/database";
import { pinProvenance } from "./grading-fixture";
// Captured fixtures exercise the same extractor, definition targets and storage read used by HTTP.
import { createFeed, integration, oakridgeProfile, scratchDatabase, tenant } from "./grading-fixture";

import { expect, test } from "bun:test";
import { selectComposite, selectDrilldown, selectLineage, selectUnlinkedItems, selectUnresolvedReferences, uniformDrilldownPages } from "../src/grading/composite";
import { all, answer, edge, evidence, grader, inputs, occurrence, otherTask, question, revision, task } from "./rollup-fixture";
const path = { logical_scope: "task" };
test("task, acceptance and linked findings retain independent scoped results and provenance, without unrelated items", () => {
  const sources = [revision("tasks", "define"), revision("plan", "plan"), revision("brief", "brief"), revision("analysis", "analyze"), revision("assessment", "verify")];
  const [own, plan, brief, analysis, assessment, derived, addressed, other] = [
    occurrence("task", sources[0]!, task), occurrence("plan-entry", sources[1]!, task), occurrence("brief-entry", sources[2]!, task),
    occurrence("analysis-finding", sources[3]!), occurrence("assessment-finding", sources[4]!), occurrence("decision", sources[1]!),
    occurrence("requirement", sources[0]!), occurrence("other-task", sources[0]!, otherTask)
  ];
  const items = [own!, plan!, brief!, analysis!, assessment!, derived!, addressed!, other!];
  const ownGrade = evidence(own!, null);
  const analysisGrade = evidence(analysis!, null);
  const taskGrade = evidence(assessment!, task, false);
  const otherGrade = evidence(assessment!, otherTask);
  const sets = [ownGrade, evidence(plan!, null), evidence(brief!, null), analysisGrade, taskGrade, evidence(assessment!, null), otherGrade];
  const snapshot = inputs({ revisions: sources, occurrences: items, relations: [edge(analysis!, task), edge(assessment!, analysis!, "supersedes"), edge(assessment!, task),
    edge(derived!, task, "derived_from"), edge(addressed!, task, "addresses")], evidence_sets: sets, answers: [answer(ownGrade), answer(analysisGrade), answer(otherGrade)],
    stages: sources.map((source) => ({ stage: source.stage, artifact_kinds: [source.artifact_kind] })),
    pins: sources.map((source) => ({ ...question, ...pinProvenance(question), scope: "per_item", artifact_kind: source.artifact_kind, item_selector: "/items/*", evaluator_definition_ids: [grader] })) });
  const before = JSON.stringify(snapshot);
  const rollup = selectComposite(snapshot, path, snapshot.logical_items[0]!);
  const results = rollup.stages.flatMap((stage) => stage.results);
  expect([...new Set(results.map((result) => String(result.item.occurrence_id)))]).toEqual(["task", "plan-entry", "brief-entry", "analysis-finding", "assessment-finding"]);
  expect(results.filter((result) => result.scope.kind === "per_task").map((result) => [result.scope, result.status.state])).toEqual([[{ kind: "per_task", task_id: task }, "not_ready"]]);
  expect(rollup.stages.flatMap((stage) => stage.answers)).toEqual([]); // Per-item answers never become task counts.
  expect(results.find((result) => result.item.occurrence_id === analysis!.occurrence_id)?.provenance).toMatchObject({ kind: "relation", hops: [{ type: "assesses", asserted_by: "producer_explicit", evidence_ref: "/items/0/task_ids/0" }] });
  const verify = rollup.stages.at(-1)!;
  const drill = selectDrilldown(snapshot, path, verify.items, uniformDrilldownPages(all));
  expect(drill.items[0]?.questions.items.map((entry) => entry.scope)).toEqual([{ kind: "per_task", task_id: task }, { kind: "per_item" }]);
  expect(drill.items[0]?.questions.items.every((entry) => entry.provenance !== null)).toBe(true);
  expect(drill.items[0]?.questions.items.flatMap((entry) => entry.results.items).map((result) => result.scope.kind)).toEqual(["per_task", "per_item"]);
  expect(JSON.stringify(snapshot)).toBe(before);
  expect("verdict" in rollup).toBe(false);
  const lineage = selectLineage(snapshot, path, "T1", all);
  expect(lineage.items.filter((entry) => entry.kind === "contribution")).toHaveLength(3);
});
test("missing grades remain explicit missing states, never passing answers", () => {
  const source = revision("finding", "inspect");
  const item = occurrence("missing", source, task);
  const set = evidence(item, task);
  const snapshot = inputs({ revisions: [source], occurrences: [item], evidence_sets: [set] });
  const rollup = selectComposite(snapshot, path, snapshot.logical_items[0]!);
  expect(rollup.stages[0]?.results.map((result) => result.status.state)).toEqual(["awaiting_admission"]);
  expect(rollup.stages[0]?.answers).toEqual([]);
  const off = selectComposite({ ...snapshot, is_grading_enabled: false }, path, snapshot.logical_items[0]!);
  expect(off.stages[0]?.results[0]?.status.state).toBe("grading_off");
  const pinned = selectComposite({ ...snapshot, evidence_sets: [{ ...set, pinned_evaluator_definition_ids: [] }] }, path, snapshot.logical_items[0]!);
  expect(pinned.stages[0]?.results[0]?.status.state).toBe("pinned");
});
test("unlinked means pinned and unassociated, while unresolved references include every captured edge", () => {
  const source = revision("new", "inspect");
  const own = occurrence("own", source, task), unlinked = occurrence("unlinked", source), ungraded = occurrence("ungraded", source);
  const unresolved = { ...edge(ungraded, task, "addresses"), target_logical_item_id: null, unresolved_target_ref: "not-captured" };
  const snapshot = inputs({ revisions: [source], occurrences: [own, unlinked, ungraded], relations: [unresolved], evidence_sets: [evidence(own, null), evidence(unlinked, null)] });
  expect(selectUnlinkedItems(snapshot, path, all).items.map((item) => item.occurrence_id)).toEqual([unlinked.occurrence_id]);
  expect(selectUnresolvedReferences(snapshot, path, all).items.map((entry) => entry.item.occurrence_id)).toEqual([ungraded.occurrence_id]);
});

integration("requirement rollup reports both repositories and only the bound assessment's judgment", async () => scratchDatabase(async (db) => {
  const feed = createFeed(db);
  await feed.revision({ revision_id: "spec:1", artifact_kind: "spec", body: { requirements: [
    { id: "R1", text: "Shared requirement", acceptance_conditions: ["Covered"], source_refs: [], analysis_finding_ids: [] },
  ] } });
  for (const repository_key of ["alpha", "beta"]) await feed.revision({
    revision_id: `${repository_key}:brief:1`, unit_id: repository_key, artifact_kind: "brief",
    body: { cohort_id: repository_key, repository_key, build_items: [{ id: "B1", requirement_ids: ["R1"], instructions: "Build", verification: ["Verify"] }], technical_decisions: [] },
  });
  await feed.revision({ revision_id: "alpha:assessment:1", artifact_kind: "assessment",
    input_bindings: [{ input: "assignment", unit: "alpha", revision_id: "alpha:brief:1" }],
    body: { item_assessments: [{ subject: { kind: "build_item", id: "B1" }, status: "partial", observation: "Some checks pass", evidence: [] }],
      additional_findings: [], proposals: [], verifications: [] } });
  const app = createApp({ db, profile: oakridgeProfile, credentials: { ingest: [], read: [{ ...tenant, token: "read" }] },
    stage_source: { read: async () => ({ ok: true, value: [] as const }) } });
  const result = await app.request("/v1/runs/run-1/logical-items/R1", { headers: { authorization: "Bearer read" } });
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ producer_local_id: "R1", task_kind: "requirement", repositories: [
    { repository_key: "alpha", judgments: [{ assessment_revision_id: "alpha:assessment:1", status: "partial" }] },
    { repository_key: "beta", judgments: [] },
  ] });
  const qualified = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.item_relation")
    .select(["asserted_by", "qualifier"]).where("qualifier", "is not", null).execute());
  expect(qualified).toEqual(expect.arrayContaining([
    { asserted_by: "producer_explicit", qualifier: { repository_key: "alpha" } },
    { asserted_by: "producer_explicit", qualifier: { repository_key: "beta" } },
  ]));
}));

test("roll-up and drilldown keep corrections within their evidence set and subject", () => {
  const source = revision("corrected", "inspect");
  const item = occurrence("shared", source, task);
  const taskSet = evidence(item, task), itemSet = evidence(item, null), otherSet = evidence(item, otherTask);
  const old = answer(taskSet);
  const corrected = { ...old, observation_id: "corrected-answer" as typeof old.observation_id,
    execution_id: "corrected-execution" as typeof old.execution_id, supersedes_observation_id: old.observation_id };
  const itemAnswer = answer(itemSet);
  const snapshot = inputs({ revisions: [source], occurrences: [item], evidence_sets: [taskSet, itemSet, otherSet],
    answers: [old, corrected, itemAnswer, answer(otherSet)] });
  const rollup = selectComposite(snapshot, path, snapshot.logical_items[0]!);
  const stage = rollup.stages[0];
  if (!stage) throw new Error("fixture stage missing");
  const expected = [String(corrected.observation_id), String(itemAnswer.observation_id)];
  expect(stage.results.flatMap((result) => result.status.state === "answered" ? [String(result.status.answer.observation_id)] : [])).toEqual(expected);
  const drill = selectDrilldown(snapshot, path, stage.items, uniformDrilldownPages(all));
  const questions = drill.items.flatMap((row) => row.questions.items);
  expect(questions.flatMap((question) => question.answers.items.map((answer) => String(answer.observation_id)))).toEqual(expected);
  expect(questions.flatMap((question) => question.results.items.flatMap((result) => result.status.state === "answered" ? [String(result.status.answer.observation_id)] : []))).toEqual(expected);
  expect(questions.flatMap((question) => question.superseded_answers.items.map((answer) => String(answer.observation_id)))).toEqual([String(old.observation_id)]);
});
