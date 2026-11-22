import { pinProvenance } from "./grading-fixture";
import { targetOf } from "./grading-fixture";
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { ArtifactRevisionId, EvaluatorDefinitionId, ItemOccurrenceId, UnitId } from "../src/domain/identity";
import type { JsonValue } from "../src/domain/primitives";
import { pageOf, selectCurrentAnswers, selectRevisionStandings, uniformDrilldownPages, type AnswerCount, type CompositeRevision, type CompositeSelector, type DrilldownPages, type LogicalItemComposite,
  type StageComposite } from "../src/grading/composite";
import type { CaptureConfiguration } from "../src/grading/evidence";
import { evaluationDigest, submissionAttemptLabel, submissionDigest } from "../src/grading/execution";
import type { GradeAnswer } from "../src/grading/observation";
import { CORRECTNESS_ID, EVIDENCE_SUPPORT_ID } from "./grading-fixture";
import { scopeOf, OAKRIDGE_QUESTIONS, oakridgeProfile, createFeed, evaluator, evaluatorId, integration, runConfig, scratchDatabase, tenant, type Feed } from "./grading-fixture";
import { readOccurrenceEvidence, recordCollection } from "../src/storage/captured-evidence-store";
import { jsonText, withTenant, type Database, type TenantScope } from "../src/storage/database";
import { listRunComposites, listRunUnlinkedItems, listRunUnresolvedReferences, readCompositeDrilldown, readLogicalItemComposite, readLogicalItemLineage } from "../src/storage/grading-record-store";
import { registerEvaluator, registerQuestion } from "../src/storage/grading-store";
import { listRunItems } from "../src/storage/projection-store";

const path = oakridgeProfile.composite;
const context = { stages: [
  { stage: "analysis", artifact_kinds: ["analysis", "spec"] }, { stage: "planning", artifact_kinds: ["plan"] },
  { stage: "brief", artifact_kinds: ["brief"] },
  { stage: "cohort", artifact_kinds: ["assessment", "build_result"] }, { stage: "integration", artifact_kinds: ["assessment"] }
], pins: [], is_run_complete: true };
const all = { limit: 200, offset: 0 };
const pages = uniformDrilldownPages(all);
const MACHINE_A = "machine-a", MACHINE_B = "machine-b", HUMAN = "human";
const configuration: CaptureConfiguration = { pins: OAKRIDGE_QUESTIONS.map((question) => ({ ...scopeOf(question.question_id), ...question, ...targetOf(question.question_id), ...pinProvenance(question),
  evaluator_definition_ids: [evaluatorId(MACHINE_A), evaluatorId(MACHINE_B), evaluatorId(HUMAN)] })) };
interface AssessmentFixture { readonly requirement_ids: readonly string[]; readonly note?: JsonValue }
const finding = (requirement_ids: readonly string[], extra: { readonly note?: JsonValue } = {}): AssessmentFixture =>
  ({ requirement_ids, ...extra });
const spec = (ids: readonly string[] = ["T7", "T8"]) => ({ requirements: ids.map((id) => ({ id, text: id, analysis_finding_ids: [] })) });
const brief = (id: string, findings: readonly AssessmentFixture[]) => ({
  cohort_id: id, repository_key: id, technical_decisions: [],
  build_items: findings.map((finding, index) => ({ id: `B${index}`, requirement_ids: [...new Set(finding.requirement_ids)] })),
});
const assess = (findings: readonly AssessmentFixture[]) => ({ item_assessments: findings.map(({ note }, index) =>
  ({ subject: { kind: "build_item", id: `B${index}` }, status: "met", evidence: [], observation: note ?? "Verified" })) });
const binding = (revision_id: string) => ({ input: "reviewed", unit: revision_id, revision_id });
const choice = (value: string): GradeAnswer => ({ state: "answered", kind: "choice", value });

interface Harness { readonly db: Database; readonly feed: Feed; readonly scope: TenantScope }
async function harness(db: Database, scope: TenantScope = tenant): Promise<Harness> {
  for (const question of OAKRIDGE_QUESTIONS) await registerQuestion(db, scope, question);
  await registerEvaluator(db, scope, evaluator("model", MACHINE_A));
  await registerEvaluator(db, scope, { ...evaluator("model", MACHINE_B), provider: "fixture-other" });
  await registerEvaluator(db, scope, evaluator("human", HUMAN));
  const feed = createFeed(db, scope, configuration);
  return { db, feed, scope };
}
const occurrenceAt = async (h: Harness, revision_id: string, item_path: string, run_id = "run-1"): Promise<ItemOccurrenceId> => {
  const items = await listRunItems(h.db, h.scope, run_id, all);
  const item = items.items.find((candidate) => candidate.revision_id === revision_id && candidate.json_pointer === item_path);
  if (!item) throw new Error(`no item at ${revision_id}${item_path}`);
  return item.occurrence_id as ItemOccurrenceId;
};
async function readyAll(h: Harness, occurrence_id: ItemOccurrenceId, only?: string): Promise<void> {
  for (const set of await readOccurrenceEvidence(h.db, h.scope, occurrence_id)) {
    if (only && set.question_id !== only) continue;
    const recorded = await recordCollection(h.db, h.scope, set.evidence_set_id, { state: "ready",
      references: [{ source: "reported", reported_by: "agent", ref: "subject", revision_id: "fixture" as ArtifactRevisionId, item_path: "/item_assessments/0", content: `evidence of ${occurrence_id}` }] });
    if (!recorded.ok) throw new Error(recorded.error.detail);
  }
}
interface Measure { readonly occurrence_id: ItemOccurrenceId; readonly question_id: string; readonly evaluator_id: string; readonly reviewer?: string;
  readonly task_id?: string; readonly answer?: GradeAnswer; readonly status?: "queued" | "budget_deferred" | "failed"; readonly supersedes?: string; readonly run_id?: string }
/** One measurement as the execution contract stores it: automatic for a machine, a submission for a reviewer. */
async function measure(h: Harness, input: Measure): Promise<string> {
  const set = (await readOccurrenceEvidence(h.db, h.scope, input.occurrence_id)).find((candidate) => candidate.question_id === input.question_id && (input.task_id === undefined || candidate.task_id?.endsWith(`:${input.task_id}`)))!;
  const submission_id = randomUUID();
  const attempt_label = input.reviewer ? submissionAttemptLabel({ reviewer_id: input.reviewer, submission_id } as never) : "automatic";
  const identity = { task_id: set.task_id, subject_occurrence_id: input.occurrence_id, evidence_set_id: set.evidence_set_id, question_id: set.question_id, question_version: set.question_version,
    evaluator_definition_id: evaluatorId(input.evaluator_id), attempt_label };
  const digest = input.reviewer ? submissionDigest({ reviewer_id: input.reviewer, submission_id } as never) : evaluationDigest(identity);
  if (!digest.ok) throw new Error(digest.error.detail);
  const execution_id = randomUUID();
  const status = input.status ?? "completed";
  const ended = status === "completed" || status === "failed";
  await withTenant(h.db, h.scope, (trx) => trx.insertInto("observation.evaluation_execution").values({ ...h.scope, ...identity, execution_id, run_id: input.run_id ?? "run-1",
    idempotency_digest: digest.value, status, lease_owner: null, lease_expires_at: null, terminal_cause: status === "failed" ? "retry_exhausted" : null, started_at: null,
    ended_at: ended ? new Date() : null, error: status === "failed" ? "transport: refused" : null, model_usage: null, cost: null, external_execution_id: null, provider_link: null,
    reproducibility_metadata: null }).execute());
  if (status !== "completed") return execution_id;
  const observation_id = randomUUID();
  const payload = input.answer ?? choice("relevant");
  await withTenant(h.db, h.scope, (trx) => trx.insertInto("observation.grade_observation").values({ ...h.scope, observation_id, execution_id, answer_kind: payload.kind, answer_state: payload.state,
    answer_payload: jsonText(payload as JsonValue), probabilities: null, confidence: null, reviewer_id: input.reviewer ?? null, reviewer_details: null, comments: null, rationale: null,
    supersedes_observation_id: input.supersedes ?? null }).execute());
  return observation_id;
}
const composite = async (h: Harness, task_id: string, run_id = "run-1"): Promise<LogicalItemComposite> => {
  const read = await readLogicalItemComposite(h.db, h.scope, path, run_id, task_id, { ...context, pins: configuration.pins });
  if (!read) throw new Error(`no composite for ${task_id}`);
  return read;
};
const stageOf = (read: LogicalItemComposite, stage: string): StageComposite => read.stages.find((candidate) => candidate.stage === stage)!;
const answersIn = (stage: StageComposite): readonly (readonly [string, string, JsonValue, number])[] => stage.answers.map((count: AnswerCount) =>
  [count.question.question_id, count.grader.kind === "human" ? `human:${count.grader.reviewer_id}` : count.grader.evaluator_definition_id,
    count.answer.state === "answered" ? count.answer.value : count.answer.state, count.count] as const);

describe("current revisions", () => {
  const at = (minute: number): Date => new Date(Date.UTC(2026, 10, 1, 0, minute));
  const revision = (revision_id: string, unit_id: string, minute: number, predecessor_id: string | null = null, artifact_kind = "assessment"): CompositeRevision =>
    ({ stage: "captured-stage", revision_id: revision_id as ArtifactRevisionId, unit_id: unit_id as UnitId, artifact_kind, predecessor_id: predecessor_id as ArtifactRevisionId | null, recorded_at: at(minute), captured_at: at(minute) });
  const current = (revisions: readonly CompositeRevision[]): readonly string[] => [...selectRevisionStandings(revisions, path).values()]
    .filter((standing) => standing.is_current).map((standing) => standing.revision.revision_id).sort();

  test("each unit keeps its own current revision: there is no latest for the run or the stage", () => {
    expect(current([revision("a1", "run/implementation/a", 1), revision("b1", "run/implementation/b", 2), revision("a2", "run/implementation/a", 3, "a1"),
      revision("i1", "run/integration/x", 4)])).toEqual(["a2", "b1", "i1"]);
  });
  test("recorded lineage decides ahead of timestamps", () => {
    expect(current([revision("new", "run/implementation/a", 1, "old"), revision("old", "run/implementation/a", 5)])).toEqual(["new"]);
  });
  test("with no named predecessor, the latest recorded stands", () => {
    expect(current([revision("a1", "run/implementation/a", 1), revision("a2", "run/implementation/a", 2)])).toEqual(["a2"]);
  });
  test("an artifact is its own stream within a unit", () => {
    expect(current([revision("a", "run/analysis", 1, null, "analysis"), revision("t", "run/analysis", 2, null, "tasks")])).toEqual(["a", "t"]);
  });
  test("a revision's captured stage places every artifact without a profile mapping", () => {
    const standings = selectRevisionStandings([revision("a", "arbitrary/unit", 1, null, "new-artifact")]);
    expect(standings.get("a")?.stage).toBe("captured-stage");
  });
});

test("a correction replaces only its own measurement: other reviewers keep theirs, and history keeps all", () => {
  const base = { execution_id: "x", occurrence_id: "o", evidence_set_id: "e", question: { question_id: "q", question_version: "1" }, evaluator_definition_id: "h", answer: choice("a"),
    confidence: null, rationale: null, comments: null, recorded_at: new Date(0) } as never as Parameters<typeof selectCurrentAnswers>[0][number];
  const answers = [{ ...base, observation_id: "first", reviewer_id: "r1", supersedes_observation_id: null }, { ...base, observation_id: "second", reviewer_id: "r1", supersedes_observation_id: "first" },
    { ...base, observation_id: "third", reviewer_id: "r1", supersedes_observation_id: "second" }, { ...base, observation_id: "other", reviewer_id: "r2", supersedes_observation_id: null }] as never as Parameters<typeof selectCurrentAnswers>[0];
  expect(selectCurrentAnswers(answers).map((answer) => String(answer.observation_id))).toEqual(["third", "other"]);
});

test("a page reports the whole list's size, and every boundary continues without loss", () => {
  const list = ["a", "b", "c", "d", "e"];
  const walked: string[] = [];
  for (let offset = 0; offset < list.length; offset += 2) {
    const page = pageOf(list, { limit: 2, offset });
    expect(page.total).toBe(5);
    walked.push(...page.items);
  }
  expect(walked).toEqual(list);
  expect(pageOf(list, { limit: 2, offset: 5 }).items).toEqual([]);
});



/** One run with a revised plan, a brief and assessment per cohort, and a shared requirement. */
async function sharedTaskRun(h: Harness, assessments: { readonly alpha: readonly AssessmentFixture[]; readonly beta: readonly AssessmentFixture[] }): Promise<void> {
  const plan = { cohorts: ["alpha", "beta"].map((id) => ({ id, allocations: [{ requirement_id: "T7", contribution: id }] })) };
  await h.feed.launch({ spec: "s" }, "run-1", runConfig(true));
  await h.feed.revision({ revision_id: "spec-1", artifact_kind: "spec", unit_id: "run-1/analysis", body: spec() });
  await h.feed.revision({ revision_id: "plan-1", artifact_kind: "plan", unit_id: "run-1/planning", body: plan });
  await h.feed.revision({ revision_id: "plan-2", artifact_kind: "plan", unit_id: "run-1/planning", predecessor_id: "plan-1", body: { ...plan, summary: "revised" } });
  await h.feed.revision({ revision_id: "brief-alpha-1", artifact_kind: "brief", unit_id: "run-1/briefs/alpha", body: brief("alpha", assessments.alpha) });
  await h.feed.revision({ revision_id: "brief-alpha-2", artifact_kind: "brief", unit_id: "run-1/briefs/alpha", predecessor_id: "brief-alpha-1", body: brief("alpha", assessments.alpha) });
  await h.feed.revision({ revision_id: "brief-beta-1", artifact_kind: "brief", unit_id: "run-1/briefs/beta", body: brief("beta", assessments.beta) });
  await h.feed.revision({ revision_id: "assessment-alpha-1", artifact_kind: "assessment", unit_id: "run-1/implementation/alpha", body: assess(assessments.alpha),
    input_bindings: [binding("brief-alpha-2")] });
  await h.feed.revision({ revision_id: "assessment-beta-1", artifact_kind: "assessment", unit_id: "run-1/implementation/beta", body: assess(assessments.beta),
    input_bindings: [binding("brief-beta-1")] });
}

integration("one task through both cohorts, revised plan and briefs: one logical item, and every cohort's current findings", async () => scratchDatabase(async (db) => {
  const h = await harness(db);
  await sharedTaskRun(h, { alpha: [finding(["T7"]), finding(["T7"]), finding(["T7", "T8"])], beta: [finding(["T7"]), finding([])] });
  const read = await composite(h, "T7");
  const implementation = stageOf(read, "cohort");
  expect([implementation.publication, implementation.totals.contributing_items, stageOf(read, "integration").publication, stageOf(read, "analysis").publication.state, read.logical_item_id as string]).toEqual([
    { state: "published", is_final: false, unit_ids: ["run-1/implementation/alpha" as UnitId, "run-1/implementation/beta" as UnitId] }, 4, { state: "pending" }, "published", `oakridge:${h.scope.namespace}:run-1:task:requirement:T7`]);
  // A finding naming two tasks contributes once to each, and copies nothing.
  const other = await composite(h, "T8");
  expect(stageOf(other, "cohort").totals.contributing_items).toBe(1);
  const unlinked = await listRunUnlinkedItems(h.db, h.scope, path, "run-1", all);
  expect(unlinked.items.filter((item) => item.item_kind === "item_assessment").map((item) => [item.revision_id, item.item_path])).toEqual([]);
  const lineage = await readLogicalItemLineage(h.db, h.scope, path, "run-1", "T7", all);
  const occurrences = lineage.items.flatMap((entry) => entry.kind === "occurrence" ? [[entry.artifact_kind, entry.revision_id, entry.is_current]] : []);
  expect(occurrences).toEqual([["spec", "spec-1", true], ["plan", "plan-1", false], ["plan", "plan-1", false], ["plan", "plan-2", true], ["plan", "plan-2", true]]);
  const briefHistory = lineage.items.flatMap((entry) => entry.kind === "contribution" && entry.item.artifact_kind === "brief" ? [[String(entry.item.revision_id), entry.item.is_current]] : []);
  expect(briefHistory).toEqual([["brief-alpha-1", false], ["brief-alpha-1", false], ["brief-alpha-1", false],
    ["brief-alpha-2", true], ["brief-alpha-2", true], ["brief-alpha-2", true], ["brief-beta-1", true]]);
  expect(lineage.items.flatMap((entry) => entry.kind === "contribution" && entry.item.artifact_kind === "assessment" ? [[entry.item.revision_id, entry.item.item_path, entry.item.stage, entry.item.is_current]] : [])).toEqual([
    ["assessment-alpha-1", "/item_assessments/0", "cohort", true], ["assessment-alpha-1", "/item_assessments/1", "cohort", true], ["assessment-alpha-1", "/item_assessments/2", "cohort", true],
    ["assessment-beta-1", "/item_assessments/0", "cohort", true]]);
  expect(lineage.is_captured).toBe(true);
}));

integration("a newer revision with no links replaces a linked one instead of resurrecting it, and history keeps what it replaced", async () => scratchDatabase(async (db) => {
  const h = await harness(db);
  await sharedTaskRun(h, { alpha: [finding(["T7"])], beta: [finding(["T7"])] });
  const old = await occurrenceAt(h, "assessment-alpha-1", "/item_assessments/0");
  await readyAll(h, old);
  await measure(h, { occurrence_id: old, question_id: CORRECTNESS_ID, evaluator_id: MACHINE_A, answer: choice("supported") });
  expect(stageOf(await composite(h, "T7"), "cohort").totals.contributing_items).toBe(2);
  await h.feed.revision({ revision_id: "assessment-alpha-2", artifact_kind: "assessment", unit_id: "run-1/implementation/alpha", predecessor_id: "assessment-alpha-1", body: { item_assessments: [] } });
  const read = stageOf(await composite(h, "T7"), "cohort");
  expect([read.totals.contributing_items, read.totals.superseded_items, read.answers]).toEqual([1, 1, []]);
  const history = await readCompositeDrilldown(h.db, h.scope, path, "run-1", read.history, pages);
  expect(history.items.map((row) => [row.item.revision_id as string, row.item.is_current, row.questions.items.flatMap((question) => question.answers.items.map((answer) => answer.answer))])).toEqual([
    ["assessment-alpha-1", false, [choice("supported")]]]);
  // Beta's own current revision was never touched by alpha's.
  const items = await readCompositeDrilldown(h.db, h.scope, path, "run-1", read.items, pages);
  expect(items.items.map((row): string => row.item.revision_id)).toEqual(["assessment-beta-1"]);
}));

integration("stages stand side by side: integration is pending, then final once published, whatever its answers and approvals", async () => scratchDatabase(async (db) => {
  const h = await harness(db);
  await sharedTaskRun(h, { alpha: [finding(["T7"])], beta: [] });
  const alpha = await occurrenceAt(h, "assessment-alpha-1", "/item_assessments/0");
  await readyAll(h, alpha);
  await measure(h, { occurrence_id: alpha, question_id: CORRECTNESS_ID, evaluator_id: MACHINE_A, answer: choice("supported") });
  expect(stageOf(await composite(h, "T7"), "integration").publication).toEqual({ state: "pending" });
  await h.feed.revision({ revision_id: "integration-1", artifact_kind: "assessment", unit_id: "run-1/integration/oakridge", body: { item_assessments: [{ subject: { kind: "requirement", id: "T7" }, status: "met", evidence: [] }] } });
  const unanswered = await composite(h, "T7");
  const integration_stage = stageOf(unanswered, "integration");
  expect([integration_stage.publication, integration_stage.state, integration_stage.answers, integration_stage.totals.contributing_items]).toEqual([
    { state: "published", is_final: true, unit_ids: ["run-1/integration/oakridge" as UnitId] }, "linked", [], 1]);
  const final = await occurrenceAt(h, "integration-1", "/item_assessments/0");
  await readyAll(h, final);
  await measure(h, { occurrence_id: final, question_id: CORRECTNESS_ID, evaluator_id: MACHINE_A, answer: choice("contradicted") });
  const read = await composite(h, "T7");
  // The two stages' answers are kept apart: nothing across them adds up.
  expect(answersIn(stageOf(read, "cohort"))).toEqual([[CORRECTNESS_ID, MACHINE_A, "supported", 1]]);
  expect(answersIn(stageOf(read, "integration"))).toEqual([[CORRECTNESS_ID, MACHINE_A, "contradicted", 1]]);
  expect(Object.keys(read).sort()).toEqual(["coverage", "logical_item_id", "producer_local_id", "repositories", "run_id", "scope", "stages", "task_kind"]);
  // A published integration with nothing linked to this task is final and a coverage gap.
  expect([stageOf(await composite(h, "T8"), "integration").publication.state, stageOf(await composite(h, "T8"), "integration").state]).toEqual(["published", "gap"]);
}));

integration("corrections count once under their own reviewer; disagreement is only on one item and question", async () => scratchDatabase(async (db) => {
  const h = await harness(db);
  await sharedTaskRun(h, { alpha: [finding(["T7"]), finding(["T7"])], beta: [] });
  const [first, second] = [await occurrenceAt(h, "assessment-alpha-1", "/item_assessments/0"), await occurrenceAt(h, "assessment-alpha-1", "/item_assessments/1")];
  await readyAll(h, first);
  await readyAll(h, second);
  const wrong = await measure(h, { occurrence_id: first, question_id: CORRECTNESS_ID, evaluator_id: HUMAN, reviewer: "reviewer-a", answer: choice("contradicted") });
  await measure(h, { occurrence_id: first, question_id: CORRECTNESS_ID, evaluator_id: HUMAN, reviewer: "reviewer-a", answer: choice("supported"), supersedes: wrong });
  await measure(h, { occurrence_id: first, question_id: CORRECTNESS_ID, evaluator_id: HUMAN, reviewer: "reviewer-b", answer: choice("supported") });
  // Different items answering differently: no disagreement, and an old corrected answer is none either.
  await measure(h, { occurrence_id: second, question_id: CORRECTNESS_ID, evaluator_id: HUMAN, reviewer: "reviewer-a", answer: choice("contradicted") });
  let stage = stageOf(await composite(h, "T7"), "cohort");
  expect(answersIn(stage)).toEqual([[CORRECTNESS_ID, "human:reviewer-a", "contradicted", 1], [CORRECTNESS_ID, "human:reviewer-a", "supported", 1], [CORRECTNESS_ID, "human:reviewer-b", "supported", 1]]);
  expect([stage.disagreements, stage.totals.superseded_answers]).toEqual([[], 1]);
  await measure(h, { occurrence_id: first, question_id: CORRECTNESS_ID, evaluator_id: MACHINE_A, answer: choice("contradicted") });
  stage = stageOf(await composite(h, "T7"), "cohort");
  expect(stage.disagreements.map((entry) => [entry.question.question_id, entry.item_count])).toEqual([[CORRECTNESS_ID, 1]]);
  const opened = await readCompositeDrilldown(h.db, h.scope, path, "run-1", stage.disagreements[0]!.drilldown, pages);
  expect(opened.items.map((row) => row.item.occurrence_id)).toEqual([first]);
  const history = await readCompositeDrilldown(h.db, h.scope, path, "run-1", stage.history, pages);
  const [row] = history.items.filter((candidate) => candidate.item.occurrence_id === first);
  const corrected = row!.questions.items.find((question) => question.question.question_id === CORRECTNESS_ID);
  expect([corrected!.superseded_answers.items.map((answer) => answer.answer), corrected!.answers.total]).toEqual([[choice("contradicted")], 3]);
}));

integration("a count is of items: two alike uncorrected answers from one reviewer count once, and open that item with both raw answers", async () => scratchDatabase(async (db) => {
  const h = await harness(db);
  await sharedTaskRun(h, { alpha: [finding(["T7"])], beta: [] });
  const occurrence_id = await occurrenceAt(h, "assessment-alpha-1", "/item_assessments/0");
  await readyAll(h, occurrence_id);
  for (let submission = 0; submission < 2; submission++)
    await measure(h, { occurrence_id, question_id: CORRECTNESS_ID, evaluator_id: HUMAN, reviewer: "reviewer-a", answer: choice("supported") });
  const stage = stageOf(await composite(h, "T7"), "cohort");
  const [count] = stage.answers;
  const opened = await readCompositeDrilldown(h.db, h.scope, path, "run-1", count!.drilldown, pages);
  expect([count!.count, opened.total, opened.items[0]!.questions.items[0]!.answers.total]).toEqual([1, 1, 2]);
}));

integration("not-ready, pending, failed, deferred and off stay distinct from each other and from negative and unclear answers", async () => scratchDatabase(async (db) => {
  const h = await harness(db);
  await sharedTaskRun(h, { alpha: [finding(["T7"]), finding(["T7"]), finding(["T7"]), finding(["T7"]), finding(["T7"]), finding(["T7"])], beta: [] });
  const at = (index: number) => occurrenceAt(h, "assessment-alpha-1", `/item_assessments/${index}`);
  // Evidence support is ready while Correctness waits for its real reason: each question moves alone.
  const split = await at(0);
  await readyAll(h, split, EVIDENCE_SUPPORT_ID);
  const correctness = (await readOccurrenceEvidence(h.db, h.scope, split)).find((set) => set.question_id === CORRECTNESS_ID)!;
  const waiting = await recordCollection(h.db, h.scope, correctness.evidence_set_id, { state: "not_ready", reason: { code: "build_result_unavailable", detail: "subject not captured" } });
  if (!waiting.ok) throw new Error(waiting.error.detail);
  const statuses = async (): Promise<StageComposite> => stageOf(await composite(h, "T7"), "cohort");
  await measure(h, { occurrence_id: split, question_id: EVIDENCE_SUPPORT_ID, evaluator_id: MACHINE_A, answer: choice("does_not_support") });
  const [queued, deferred, failed, negative] = [await at(1), await at(2), await at(3), await at(4)];
  for (const occurrence_id of [queued, deferred, failed, negative]) await readyAll(h, occurrence_id, CORRECTNESS_ID);
  await measure(h, { occurrence_id: queued, question_id: CORRECTNESS_ID, evaluator_id: MACHINE_A, status: "queued" });
  await measure(h, { occurrence_id: deferred, question_id: CORRECTNESS_ID, evaluator_id: MACHINE_A, status: "budget_deferred" });
  await measure(h, { occurrence_id: failed, question_id: CORRECTNESS_ID, evaluator_id: MACHINE_A, status: "failed" });
  await measure(h, { occurrence_id: negative, question_id: CORRECTNESS_ID, evaluator_id: MACHINE_A, answer: choice("contradicted") });
  await measure(h, { occurrence_id: negative, question_id: CORRECTNESS_ID, evaluator_id: MACHINE_B, answer: choice("unclear") });
  const stage = await statuses();
  const of = (question: string, state: string, evaluator_id: string | null) => stage.statuses.filter((count) => count.question.question_id === question && count.status.state === state
    && count.evaluator_definition_id === (evaluator_id as EvaluatorDefinitionId | null));
  expect(of(CORRECTNESS_ID, "not_ready", null).map((count) => [count.status, count.count])).toEqual([[{ state: "not_ready", code: "build_result_unavailable" }, 1],
    [{ state: "not_ready", code: "collection_pending" }, 1]]);
  expect(of(CORRECTNESS_ID, "pending", MACHINE_A).map((count) => count.count)).toEqual([1]);
  expect(of(CORRECTNESS_ID, "budget_deferred", MACHINE_A).map((count) => count.count)).toEqual([1]);
  expect(of(CORRECTNESS_ID, "failed", MACHINE_A).map((count) => [count.status, count.count])).toEqual([[{ state: "failed", terminal_cause: "retry_exhausted" }, 1]]);
  expect(answersIn(stage).filter(([question]) => question === CORRECTNESS_ID)).toEqual([[CORRECTNESS_ID, MACHINE_A, "contradicted", 1], [CORRECTNESS_ID, MACHINE_B, "unclear", 1]]);
  expect(answersIn(stage).filter(([question]) => question === EVIDENCE_SUPPORT_ID)).toEqual([[EVIDENCE_SUPPORT_ID, MACHINE_A, "does_not_support", 1]]);
  expect(stage.totals).toMatchObject({ contributing_items: 6, failed_items: 1, budget_deferred_items: 1, grading_off_items: 0 });
  expect(stage.totals.not_ready_items).toBe(6);
  // Each status opens the items in it, with the real reason, and a count equals its drilldown's total.
  for (const count of stage.statuses) expect([(await readCompositeDrilldown(h.db, h.scope, path, "run-1", count.drilldown, pages)).total, count.status.state]).toEqual([count.count, count.status.state]);
  for (const count of stage.answers) expect((await readCompositeDrilldown(h.db, h.scope, path, "run-1", count.drilldown, pages)).total).toBe(count.count);
  const opened = await readCompositeDrilldown(h.db, h.scope, path, "run-1", of(CORRECTNESS_ID, "not_ready", null)[0]!.drilldown, pages);
  expect(opened.items[0]!.questions.items[0]!.statuses.items[0]!.detail).toBe("subject not captured");
}));

integration("a run with grading off reads as off, not as an answer", async () => scratchDatabase(async (db) => {
  const h = await harness(db);
  await h.feed.launch({ spec: "s" }, "run-1", runConfig(false));
  await h.feed.revision({ revision_id: "spec-1", artifact_kind: "spec", unit_id: "run-1/analysis", body: spec() });
  await h.feed.revision({ revision_id: "assessment-1", artifact_kind: "assessment", unit_id: "run-1/integration/alpha", body: { item_assessments: [{ subject: { kind: "requirement", id: "T7" }, status: "met", evidence: [] }] } });
  await readyAll(h, await occurrenceAt(h, "assessment-1", "/item_assessments/0"));
  const stage = stageOf(await composite(h, "T7"), "integration");
  expect([stage.answers, stage.totals.grading_off_items, [...new Set(stage.statuses.map((count) => count.status.state))]]).toEqual([[], 1, ["grading_off"]]);
}));

integration("an unknown task stays visible until the task arrives, then counts under it", async () => scratchDatabase(async (db) => {
  const h = await harness(db);
  await h.feed.launch({ spec: "s" }, "run-1", runConfig(true));
  await h.feed.revision({ revision_id: "assessment-1", artifact_kind: "assessment", unit_id: "run-1/integration/alpha", body: { item_assessments: [{ subject: { kind: "requirement", id: "T7" }, status: "met", evidence: [] }] } });
  expect(await readLogicalItemComposite(h.db, h.scope, path, "run-1", "T7")).toBeNull();
  expect((await listRunUnresolvedReferences(h.db, h.scope, path, "run-1", all)).items.map((reference) => reference.unresolved_target_ref)).toEqual(["logical_item:task:requirement:T7"]);
  const lineage = await readLogicalItemLineage(h.db, h.scope, path, "run-1", "T7", all);
  expect([lineage.is_captured, lineage.items.map((entry) => entry.kind)]).toEqual([false, ["unresolved"]]);
  await h.feed.revision({ revision_id: "spec-1", artifact_kind: "spec", unit_id: "run-1/analysis", body: spec() });
  expect((await listRunUnresolvedReferences(h.db, h.scope, path, "run-1", all)).items.every((reference) => reference.unresolved_target_ref !== "logical_item:task:requirement:T7")).toBe(true);
  expect(stageOf(await composite(h, "T7"), "integration").totals.contributing_items).toBe(1);
}));



integration("every list pages to its whole population, nested lists included, and a count covers more than any page", async () => scratchDatabase(async (db) => {
  const h = await harness(db);
  await sharedTaskRun(h, { alpha: [finding(["T7"]), finding(["T7"]), finding(["T7"]), finding(["T7"], { note: "fourth" })], beta: [] });
  const ids = await Promise.all([0, 1, 2, 3].map((index) => occurrenceAt(h, "assessment-alpha-1", `/item_assessments/${index}`)));
  for (const occurrence_id of ids) {
    await readyAll(h, occurrence_id, CORRECTNESS_ID);
    await measure(h, { occurrence_id, question_id: CORRECTNESS_ID, evaluator_id: MACHINE_A, answer: choice("supported") });
  }
  await measure(h, { occurrence_id: ids[0]!, question_id: CORRECTNESS_ID, evaluator_id: HUMAN, reviewer: "reviewer-a", answer: choice("supported") });
  await measure(h, { occurrence_id: ids[0]!, question_id: CORRECTNESS_ID, evaluator_id: HUMAN, reviewer: "reviewer-b", answer: choice("supported") });
  const stage = stageOf(await composite(h, "T7"), "cohort");
  const count = stage.answers.find((entry) => entry.grader.kind === "machine")!;
  expect(count.count).toBe(4);
  const seen: string[] = [];
  for (let offset = 0; ; offset += 2) {
    const page = await readCompositeDrilldown(h.db, h.scope, path, "run-1", count.drilldown, { ...pages, rows: { limit: 2, offset } });
    expect(page.total).toBe(4);
    if (page.items.length === 0) break;
    seen.push(...page.items.map((row) => row.item.occurrence_id));
  }
  expect(seen.sort()).toEqual([...ids].sort());
  const composites = await listRunComposites(h.db, h.scope, path, "run-1", { limit: 1, offset: 1 });
  expect([composites.total, composites.items.map((item) => item.producer_local_id)]).toEqual([2, ["T8"]]);
  const lineage = await readLogicalItemLineage(h.db, h.scope, path, "run-1", "T7", { limit: 2, offset: 0 });
  expect([lineage.items.length, lineage.total > 2]).toEqual([2, true]);
  for (const selector of [{ kind: "items" }, { kind: "history" }] satisfies readonly CompositeSelector[])
    expect((await readCompositeDrilldown(h.db, h.scope, path, "run-1", { ...stage.items, selector }, { ...pages, rows: { limit: 1, offset: 9 } })).items).toEqual([]);
}));

integration("a drilldown's questions and every list inside them continue separately, each reporting its whole size", async () => scratchDatabase(async (db) => {
  const h = await harness(db);
  await sharedTaskRun(h, { alpha: [finding(["T7", "T8"])], beta: [] });
  const occurrence_id = await occurrenceAt(h, "assessment-alpha-1", "/item_assessments/0");
  await readyAll(h, occurrence_id);
  const wrong = await measure(h, { occurrence_id, question_id: CORRECTNESS_ID, evaluator_id: HUMAN, reviewer: "reviewer-a", answer: choice("contradicted") });
  await measure(h, { occurrence_id, question_id: CORRECTNESS_ID, evaluator_id: HUMAN, reviewer: "reviewer-a", answer: choice("supported"), supersedes: wrong });
  const wrong_again = await measure(h, { occurrence_id, question_id: CORRECTNESS_ID, evaluator_id: HUMAN, reviewer: "reviewer-b", answer: choice("contradicted") });
  await measure(h, { occurrence_id, question_id: CORRECTNESS_ID, evaluator_id: HUMAN, reviewer: "reviewer-b", answer: choice("supported"), supersedes: wrong_again });
  await measure(h, { occurrence_id, question_id: CORRECTNESS_ID, evaluator_id: HUMAN, reviewer: "reviewer-c", answer: choice("supported") });
  await measure(h, { occurrence_id, question_id: EVIDENCE_SUPPORT_ID, evaluator_id: HUMAN, reviewer: "reviewer-a", answer: choice("supports") });
  const stage = stageOf(await composite(h, "T7"), "cohort");
  const open = (windows: Partial<DrilldownPages>) => readCompositeDrilldown(h.db, h.scope, path, "run-1", stage.items, { ...pages, ...windows });
  const one = { limit: 1, offset: 0 };

  // The question list itself: one window per question, the whole size on each, nothing past its end.
  const walked: string[] = [];
  for (let offset = 0; offset < 2; offset++) {
    const { questions } = (await open({ questions: { limit: 1, offset } })).items[0]!;
    expect([questions.total, questions.limit, questions.offset, questions.items.length]).toEqual([2, 1, offset, 1]);
    walked.push(questions.items[0]!.question.question_id);
  }
  expect(walked.sort()).toEqual([CORRECTNESS_ID, EVIDENCE_SUPPORT_ID].sort());
  const past = (await open({ questions: { limit: 1, offset: 2 } })).items[0]!.questions;
  expect([past.total, past.items]).toEqual([2, []]);

  // Inside one question held still, its current and superseded answers each continue on their own.
  const position = walked.indexOf(CORRECTNESS_ID);
  const held = { questions: { limit: 1, offset: position } };
  const current: string[] = [];
  for (let offset = 0; offset < 3; offset++) {
    const question = (await open({ ...held, answers: { limit: 1, offset }, superseded_answers: { limit: 2, offset: 0 } })).items[0]!.questions.items[0]!;
    expect([question.question.question_id, question.answers.total, question.superseded_answers.total, question.superseded_answers.items.length]).toEqual([CORRECTNESS_ID, 3, 2, 2]);
    current.push(...question.answers.items.map((answer) => answer.observation_id));
  }
  expect(new Set(current).size).toBe(3);
  const superseded: string[] = [];
  for (let offset = 0; offset < 2; offset++) {
    const question = (await open({ ...held, answers: { limit: 3, offset: 0 }, superseded_answers: { limit: 1, offset } })).items[0]!.questions.items[0]!;
    expect([question.superseded_answers.total, question.answers.items.length]).toEqual([2, 3]);
    superseded.push(...question.superseded_answers.items.map((answer) => answer.observation_id));
  }
  expect(superseded.sort()).toEqual([wrong, wrong_again].sort());

  // Moving one list's window moves no other, and links and statuses have their own.
  const { links, questions } = (await open({ links: { limit: 1, offset: 1 }, questions: one, statuses: { limit: 0, offset: 0 } })).items[0]!;
  expect([links.total, links.items.length, links.offset]).toEqual([1, 0, 1]);
  expect((await open({ links: one })).items[0]!.links.items).toHaveLength(1);
  const [opened] = questions.items;
  expect([opened!.statuses.limit, opened!.statuses.items]).toEqual([0, []]);
}));

integration("reads stop at the run and the tenant, even for the same ids", async () => scratchDatabase(async (db) => {
  const h = await harness(db);
  await sharedTaskRun(h, { alpha: [finding(["T7"])], beta: [] });
  await h.feed.revision({ revision_id: "spec-other", artifact_kind: "spec", run_id: "run-2", unit_id: "run-2/analysis", body: spec() });
  await h.feed.revision({ revision_id: "assessment-other", artifact_kind: "assessment", run_id: "run-2", unit_id: "run-2/integration/alpha", body: { item_assessments: [0, 1].map(() => ({ subject: { kind: "requirement", id: "T7" }, status: "met", evidence: [] })) } });
  expect(stageOf(await composite(h, "T7"), "cohort").totals.contributing_items).toBe(1);
  expect(stageOf(await composite(h, "T7", "run-2"), "integration").totals.contributing_items).toBe(2);
  const other: TenantScope = { producer: "oakridge", namespace: "other-tenant" };
  expect(await readLogicalItemComposite(h.db, other, path, "run-1", "T7")).toBeNull();
  expect(await listRunComposites(h.db, other, path, "run-1", all)).toEqual({ items: [], total: 0, ...all });
  const stage = stageOf(await composite(h, "T7"), "cohort");
  expect((await readCompositeDrilldown(h.db, other, path, "run-1", stage.items, pages)).total).toBe(0);
  expect((await readLogicalItemLineage(h.db, other, path, "run-1", "T7", all)).total).toBe(0);
}));

integration("a full task page keeps shared findings and independent task grades across page boundaries", async () => scratchDatabase(async (db) => {
  const h = await harness(db);
  const ids = Array.from({ length: 60 }, (_, index) => `T${String(index).padStart(2, "0")}`);
  await h.feed.revision({ revision_id: "many-requirements", artifact_kind: "spec", unit_id: "run-1/analysis", body: spec(ids) });
  await h.feed.revision({ revision_id: "shared-brief", artifact_kind: "brief", body: brief("alpha", [finding(ids)]) });
  await h.feed.revision({ revision_id: "shared", artifact_kind: "assessment", unit_id: "run-1/implementation/alpha",
    body: assess([finding(ids)]), input_bindings: [binding("shared-brief")] });
  const occurrence_id = await occurrenceAt(h, "shared", "/item_assessments/0");
  await readyAll(h, occurrence_id);
  await measure(h, { occurrence_id, question_id: CORRECTNESS_ID, evaluator_id: MACHINE_A, answer: choice("supported") });
  const first = await measure(h, { occurrence_id, question_id: CORRECTNESS_ID, evaluator_id: HUMAN, reviewer: "reviewer", answer: choice("supported") });
  await measure(h, { occurrence_id, question_id: CORRECTNESS_ID, evaluator_id: HUMAN, reviewer: "reviewer", answer: choice("contradicted"), supersedes: first });
  const firstPage = await listRunComposites(db, tenant, path, "run-1", { limit: 50, offset: 0 });
  const secondPage = await listRunComposites(db, tenant, path, "run-1", { limit: 50, offset: 50 });
  expect([firstPage.total, firstPage.items.length, secondPage.total, secondPage.items.length]).toEqual([60, 50, 60, 10]);
  expect([...firstPage.items, ...secondPage.items].map((item) => item.producer_local_id)).toEqual(ids);
  for (const item of [...firstPage.items, ...secondPage.items]) {
    const stage = stageOf(item, "cohort");
    if (item.producer_local_id !== ids[0]) {
      expect(stage.totals).toMatchObject({ contributing_items: 1, superseded_answers: 0 });
      expect(stage.answers).toEqual([]);
      expect(stage.disagreements).toEqual([]);
      continue;
    }
    expect(stage.totals).toMatchObject({ contributing_items: 1, superseded_answers: 1 });
    expect(answersIn(stage)).toEqual([[CORRECTNESS_ID, "human:reviewer", "contradicted", 1], [CORRECTNESS_ID, MACHINE_A, "supported", 1]]);
    expect(stage.disagreements[0]?.item_count).toBe(1);
  }
}));

integration("a finding naming two tasks yields independent grades counted only under their own task", async () => scratchDatabase(async (db) => {
  const h = await harness(db);
  await sharedTaskRun(h, { alpha: [finding(["T7", "T8", "T7"])], beta: [] });
  const occurrence_id = await occurrenceAt(h, "assessment-alpha-1", "/item_assessments/0");
  await readyAll(h, occurrence_id);
  await measure(h, { occurrence_id, task_id: "T7", question_id: CORRECTNESS_ID, evaluator_id: MACHINE_A, answer: choice("supported") });
  const t7 = stageOf(await composite(h, "T7"), "cohort");
  const t8 = stageOf(await composite(h, "T8"), "cohort");
  expect(answersIn(t7)).toEqual([[CORRECTNESS_ID, MACHINE_A, "supported", 1]]);
  expect(t8.answers).toEqual([]);
  expect(t8.totals.pending_items).toBe(1);
  const drill = await readCompositeDrilldown(db, tenant, path, "run-1", t8.items, pages);
  expect(drill.items[0]!.questions.items.flatMap((question) => question.answers.items)).toEqual([]);
  const sets = await readOccurrenceEvidence(db, tenant, occurrence_id);
  expect(sets.filter((set) => set.question_id === CORRECTNESS_ID)).toHaveLength(2);
}));

integration("requirement composites include technical decisions, additional findings and exact-citation proposals with their hops", async () => scratchDatabase(async (db) => {
  const h = await harness(db);
  const run_id = "lineage";
  await h.feed.revision({ run_id, revision_id: "spec:1", artifact_kind: "spec", body: { requirements: [
    { id: "R1", analysis_finding_ids: [], text: "Required", acceptance_conditions: ["Works"], source_refs: [] },
  ] } });
  await h.feed.revision({ run_id, revision_id: "brief:1", artifact_kind: "brief", body: { cohort_id: "first", repository_key: "oakridge",
    build_items: [{ id: "B1", requirement_ids: ["R1"], instructions: "Build", verification: ["Test"] }],
    technical_decisions: [{ id: "D1", build_item_ids: ["B1"], decision: "Use the checked input", rationale: "It is authoritative" }] } });
  await h.feed.revision({ run_id, revision_id: "assessment:1", artifact_kind: "assessment",
    input_bindings: [{ input: "assignment", unit: "brief", revision_id: "brief:1" }],
    body: { item_assessments: [{ subject: { kind: "build_item", id: "B1" }, status: "met", observation: "Verified", evidence: [] }],
      additional_findings: [{ id: "F1", severity: "warning", observation: "Follow up", related_build_item_ids: ["B1"], evidence: [] }],
      proposals: [{ key: "P1", instruction: "Add another test", citation: { revision_id: "assessment:1", pointer: "/item_assessments/0" } }],
      verifications: [] } });
  const loaded = await readLogicalItemComposite(db, h.scope, path, run_id, "R1");
  expect(loaded).not.toBeNull();
  const lineage = await readLogicalItemLineage(db, h.scope, path, run_id, "R1", all);
  const contributions = new Map(lineage.items.flatMap((entry) => entry.kind === "contribution" ?
    [[entry.item.item_kind, entry.provenance.hops.map((hop) => hop.type)] as const] : []));
  expect(contributions.get("technical_decision")).toEqual(["addresses", "addresses"]);
  expect(contributions.get("additional_finding")).toEqual(["addresses", "addresses"]);
  expect(contributions.get("feedback_proposal")).toEqual(["addresses", "assesses", "derived_from"]);
  const drilled = await Promise.all(loaded!.stages.map((stage) => readCompositeDrilldown(db, h.scope, path, run_id, stage.items, pages)));
  expect(drilled.flatMap((stage) => stage.items.map((row) => row.item.item_kind))).toEqual(expect.arrayContaining([
    "technical_decision", "additional_finding", "feedback_proposal",
  ]));
}));
