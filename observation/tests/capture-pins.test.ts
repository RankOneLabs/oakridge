import { expect, test } from "bun:test";
import { sql } from "kysely";
import type { ArtifactRevisionId, ItemOccurrenceId, QuestionId, RunId } from "../src/domain/identity";
import { planRegistration } from "../src/grading/configuration";
import { COLLECTION_PENDING, isPinTarget, type CapturePin } from "../src/grading/evidence";
import { CONTRIBUTION_COVERAGE_ID, CORRECTNESS_ID, EVIDENCE_SUPPORT_ID, RELEVANCE_ID, TASK_COVERAGE_ID } from "../src/producers/oakridge/evidence";
import { OAKRIDGE_QUESTIONS, committedDefinitions, oakridgeGradingRegistry, questionVersion, targetOf, oakridgeProfile, createFeed, evaluator, evaluatorId, fixtureBody, integration, scratchDatabase, tenant } from "./grading-fixture";
import { collectPinnedQuestion, pinSubjectInTransaction, readOccurrenceEvidence, recordCollection } from "../src/storage/captured-evidence-store";
import { NO_CAPTURE_PINS as NO_PINS, type CaptureConfiguration } from "../src/grading/evidence";
import { withTenant, type Database } from "../src/storage/database";
import { registerDefinitions, registerEvaluator, registerQuestion } from "../src/storage/grading-store";
import { listRunItems, projectRevisionInTransaction } from "../src/storage/projection-store";

const pinsFor = (...evaluators: readonly string[]): CaptureConfiguration => ({ pins: OAKRIDGE_QUESTIONS.map((question) => ({ scope: "per_item" as const,
  question_id: question.question_id, question_version: question.question_version, ...targetOf(question.question_id),
  evaluator_definition_ids: evaluators.map(evaluatorId) })) });

async function registerAll(db: Database): Promise<void> {
  for (const question of OAKRIDGE_QUESTIONS) await registerQuestion(db, tenant, question);
  for (const [kind, id] of [["model", "grader-a"], ["model", "grader-b"], ["human", "operator"]] as const)
    await registerEvaluator(db, tenant, evaluator(kind, id));
}
async function occurrences(db: Database, item_kind: string): Promise<readonly ItemOccurrenceId[]> {
  const page = await listRunItems(db, tenant, "run-1", { limit: 200, offset: 0 });
  return page.items.filter((item) => item.item_kind === item_kind).map((item) => item.occurrence_id as ItemOccurrenceId);
}
const executionCount = (db: Database) => withTenant(db, tenant, async (trx) =>
  (await sql<{ count: number }>`SELECT count(*)::integer AS count FROM observation.evaluation_execution`.execute(trx)).rows[0]?.count);

integration("capture pins each applicable question and full evaluator set, not ready, with no execution", async () => scratchDatabase(async (db) => {
  await registerAll(db);
  const feed = createFeed(db, tenant, pinsFor("grader-a", "operator"));
  await feed.revision({ revision_id: "assessment-1", artifact_kind: "assessment", body: await fixtureBody("assessment") });
  await feed.revision({ revision_id: "analysis-1", artifact_kind: "analysis", body: await fixtureBody("analysis") });
  const [assessment] = await occurrences(db, "assessment_finding");
  const pinned = await readOccurrenceEvidence(db, tenant, assessment!);
  expect(pinned.map((set) => set.question_id)).toEqual([CORRECTNESS_ID, EVIDENCE_SUPPORT_ID]);
  for (const set of pinned) expect(set).toMatchObject({ question_version: questionVersion(set.question_id), pinned_evaluator_definition_ids: ["grader-a", "operator"],
    readiness: { state: "not_ready", reason: COLLECTION_PENDING } });
  const [finding] = await occurrences(db, "finding");
  expect((await readOccurrenceEvidence(db, tenant, finding!)).map((set) => set.question_id)).toEqual([RELEVANCE_ID]);
  const [risk] = await occurrences(db, "risk");
  expect(await readOccurrenceEvidence(db, tenant, risk!)).toEqual([]);
  expect(await executionCount(db)).toBe(0);
}));

integration("a pin needs a registered question and evaluator, and rejects another item kind", async () => scratchDatabase(async (db) => {
  await registerAll(db);
  const body = await fixtureBody("analysis");
  await expect(createFeed(db, tenant, pinsFor("missing-evaluator")).revision({ revision_id: "analysis-1", artifact_kind: "analysis", body }))
    .rejects.toThrow("evaluator definition that does not exist");
  await expect(createFeed(db, tenant, pinsFor("grader-a", "grader-a")).revision({ revision_id: "analysis-1", artifact_kind: "analysis", body }))
    .rejects.toThrow("pins an evaluator twice");
  const mismatched: CaptureConfiguration = { pins: [{ scope: "per_item", ...OAKRIDGE_QUESTIONS[1]!, ...targetOf(RELEVANCE_ID), evaluator_definition_ids: [evaluatorId("grader-a")] }] };
  await expect(createFeed(db, tenant, mismatched).revision({ revision_id: "analysis-1", artifact_kind: "analysis", body }))
    .rejects.toThrow("does not apply to its subject item kind");
  // The refused deliveries rolled back with their capture transaction.
  expect(await occurrences(db, "finding")).toEqual([]);
}));

integration("a later configuration reaches later captures only; replay never repins", async () => scratchDatabase(async (db) => {
  await registerAll(db);
  const first = createFeed(db, tenant, pinsFor("grader-a", "operator"));
  await first.revision({ revision_id: "analysis-1", artifact_kind: "analysis", body: await fixtureBody("analysis") });
  const [earlier] = await occurrences(db, "finding");
  const before = await readOccurrenceEvidence(db, tenant, earlier!);
  // The swapped configuration re-projects the old revision, as a restart replay could.
  await withTenant(db, tenant, (trx) => projectRevisionInTransaction(trx, tenant, "analysis-1",
    { extraction: oakridgeProfile.extraction, configuration: pinsFor("grader-b", "operator") }));
  expect(await readOccurrenceEvidence(db, tenant, earlier!)).toEqual(before);
  await first.revision({ revision_id: "analysis-2", artifact_kind: "analysis", body: await fixtureBody("analysis") }, pinsFor("grader-b", "operator"));
  const later = (await occurrences(db, "finding")).find((id) => id !== earlier);
  expect(await readOccurrenceEvidence(db, tenant, later!)).toMatchObject([{ pinned_evaluator_definition_ids: ["grader-b", "operator"] }]);
  expect(await readOccurrenceEvidence(db, tenant, earlier!)).toMatchObject([{ pinned_evaluator_definition_ids: ["grader-a", "operator"] }]);
}));

integration("readiness moves per question; ready evidence is frozen and shared", async () => scratchDatabase(async (db) => {
  await registerAll(db);
  await createFeed(db, tenant, pinsFor("grader-a", "operator")).revision({ revision_id: "assessment-1", artifact_kind: "assessment", body: await fixtureBody("assessment") });
  const [occurrence] = await occurrences(db, "assessment_finding");
  const [correctness, support] = await readOccurrenceEvidence(db, tenant, occurrence!);
  const waiting = await recordCollection(db, tenant, correctness!.evidence_set_id,
    { state: "not_ready", reason: { code: "build_result_unavailable", detail: "build result b1 is not captured" } });
  expect(waiting.ok && waiting.value.readiness).toEqual({ state: "not_ready", reason: { code: "build_result_unavailable", detail: "build result b1 is not captured" } });
  const references = [{ source: "reported", reported_by: "agent", ref: "subject", revision_id: "revision-1" as ArtifactRevisionId, item_path: "/findings/0", content: "cited" }] as const;
  const frozen = await recordCollection(db, tenant, support!.evidence_set_id, { state: "ready", references });
  expect(frozen.ok && frozen.value.readiness.state).toBe("ready");
  const [stillWaiting, stillReady] = await readOccurrenceEvidence(db, tenant, occurrence!);
  expect(stillWaiting?.readiness.state).toBe("not_ready");
  expect(stillReady?.readiness).toMatchObject({ state: "ready", references });
  const later = await recordCollection(db, tenant, support!.evidence_set_id,
    { state: "ready", references: [{ source: "reported", reported_by: "agent", ref: "subject", revision_id: "revision-1" as ArtifactRevisionId, item_path: "/findings/0", content: "replacement" }] });
  expect(later.ok && later.value.readiness).toEqual(stillReady!.readiness);
  await expect(withTenant(db, tenant, (trx) => sql`UPDATE observation.evidence_set SET evidence_refs = '[]'::jsonb
    WHERE evidence_set_id = ${support!.evidence_set_id}`.execute(trx))).rejects.toThrow("ready evidence_set is frozen");
  await expect(withTenant(db, tenant, (trx) => sql`UPDATE observation.evidence_set SET pinned_evaluator_definition_ids = '{grader-b}'
    WHERE evidence_set_id = ${correctness!.evidence_set_id}`.execute(trx))).rejects.toThrow("pin is immutable");
  expect(await executionCount(db)).toBe(0);
}));

integration("a pinned question is collected through the port, and ready evidence is not collected again", async () => scratchDatabase(async (db) => {
  await registerAll(db);
  await createFeed(db, tenant, pinsFor("grader-a")).revision({ revision_id: "analysis-1", artifact_kind: "analysis", body: await fixtureBody("analysis") });
  const [occurrence] = await occurrences(db, "finding");
  const [pinned] = await readOccurrenceEvidence(db, tenant, occurrence!);
  let collected = 0;
  const source = { read: async (occurrence_id: ItemOccurrenceId) => ({ occurrence_id, run_id: "run-1" as RunId, revision_id: "analysis-1" as ArtifactRevisionId,
    item_path: "/findings/0", item_kind: "finding", selected_value: "finding" }),
    collect: async () => { collected++; return { state: "ready" as const, references: [] }; } };
  const first = await collectPinnedQuestion(db, tenant, source, pinned!);
  expect(first.ok && first.value.readiness.state).toBe("ready");
  if (!first.ok) return;
  expect((await collectPinnedQuestion(db, tenant, source, first.value)).ok).toBe(true);
  expect(collected).toBe(1);
}));

integration("referenced definitions survive: a change under the same key is refused, a new key is added", async () => scratchDatabase(async (db) => {
  await registerAll(db);
  expect((await registerEvaluator(db, tenant, evaluator("model", "grader-a"))).ok).toBe(true);
  const changed = await registerEvaluator(db, tenant, { ...evaluator("model", "grader-a"), model: "replacement" });
  expect(changed).toMatchObject({ ok: false, error: { detail: "evaluator definition identity conflict" } });
  const reworded = await registerQuestion(db, tenant, { ...OAKRIDGE_QUESTIONS[0]!, question_text: "Reworded" });
  expect(reworded).toMatchObject({ ok: false, error: { detail: "question definition identity conflict" } });
  expect((await registerQuestion(db, tenant, { ...OAKRIDGE_QUESTIONS[0]!, question_version: "2", question_text: "Reworded" })).ok).toBe(true);
}));

/** The committed definitions, registered: the configuration the service captures with. */
async function committedCapture(db: Database) {
  const registration = planRegistration(await committedDefinitions(), oakridgeGradingRegistry);
  if (!registration.ok) throw new Error(registration.error.detail);
  const registered = await registerDefinitions(db, tenant, registration.value);
  if (!registered.ok) throw new Error(registered.error.detail);
  return registration.value;
}
/** Distinct pinned question ids per captured artifact and selector, in a stable order. */
async function pinnedByTarget(db: Database): Promise<{ readonly [target: string]: readonly string[] }> {
  const page = await listRunItems(db, tenant, "run-1", { limit: 200, offset: 0 });
  const grouped = new Map<string, Set<string>>();
  for (const item of page.items) {
    const target = `${item.artifact_kind} ${item.item_selector}`;
    const questions = grouped.get(target) ?? new Set<string>();
    for (const set of await readOccurrenceEvidence(db, tenant, item.occurrence_id as ItemOccurrenceId)) questions.add(set.question_id);
    grouped.set(target, questions);
  }
  return Object.fromEntries([...grouped].sort(([left], [right]) => left.localeCompare(right)).map(([target, questions]) => [target, [...questions].sort()]));
}
async function captureEveryArtifact(feed: ReturnType<typeof createFeed>): Promise<void> {
  // Tasks come first so every assessment finding naming a known task resolves at capture.
  for (const artifact_kind of ["tasks", "analysis", "plan", "brief", "assessment"])
    await feed.revision({ revision_id: `${artifact_kind}-1`, artifact_kind, body: await fixtureBody(artifact_kind) });
}

test("a pin's target is its artifact, selector and item kind together", () => {
  const plan = { artifact_kind: "plan", item_selector: "/cohorts/*/acceptance_criteria/*", item_kind: "acceptance_entry" };
  expect([
    isPinTarget(plan, plan),
    isPinTarget(plan, { ...plan, artifact_kind: "brief", item_selector: "/acceptance_criteria/*" }),
    isPinTarget(plan, { ...plan, item_selector: "/acceptance_criteria/*" }),
    isPinTarget(plan, { ...plan, item_kind: "decision" }),
  ]).toEqual([true, false, false, false]);
});

integration("plan acceptance entries are pinned task coverage and brief acceptance entries are not", async () => scratchDatabase(async (db) => {
  const registration = await committedCapture(db);
  await captureEveryArtifact(createFeed(db, tenant, registration.capture));
  const pinned = await pinnedByTarget(db);
  expect([pinned["plan /cohorts/*/acceptance_criteria/*"], pinned["brief /acceptance_criteria/*"]]).toEqual([[CONTRIBUTION_COVERAGE_ID], []]);
}));

integration("every captured item is pinned exactly the questions whose declared target is its artifact and selector", async () => scratchDatabase(async (db) => {
  const registration = await committedCapture(db);
  await captureEveryArtifact(createFeed(db, tenant, registration.capture));
  expect(await pinnedByTarget(db)).toEqual({
    "analysis /findings/*": [RELEVANCE_ID],
    "analysis /proposed_spec_updates/*": [],
    "analysis /requirements/*/status": [],
    "analysis /risks/*": [],
    "assessment /findings/*": [CORRECTNESS_ID, EVIDENCE_SUPPORT_ID],
    "brief /acceptance_criteria/*": [],
    "brief /approaches_rejected/*": [],
    "brief /decisions_made/*": [],
    "plan /cohorts/*/acceptance_criteria/*": [CONTRIBUTION_COVERAGE_ID],
    "plan /cohorts/*/decisions/*": [],
    "plan /risks/*": [],
    "tasks /tasks/*": [TASK_COVERAGE_ID],
  });
}));

integration("late task resolution pins only per-task questions targeting the finding's artifact and selector", async () => scratchDatabase(async (db) => {
  const registration = await committedCapture(db);
  const correctness = registration.capture.pins.find((pin) => pin.question_id === CORRECTNESS_ID)!;
  const elsewhere = "assessment_finding.elsewhere" as QuestionId;
  // Same item kind and scope as correctness, declared for another artifact.
  await registerQuestion(db, tenant, { ...registration.questions.find((question) => question.question_id === CORRECTNESS_ID)!, question_id: elsewhere });
  const decoy: CapturePin = { ...correctness, question_id: elsewhere, artifact_kind: "integration" };
  const feed = createFeed(db, tenant, { pins: [...registration.capture.pins, decoy] });
  await feed.revision({ revision_id: "assessment-1", artifact_kind: "assessment", body: await fixtureBody("assessment") });
  const both_tasks = (await listRunItems(db, tenant, "run-1", { limit: 200, offset: 0 })).items
    .find((item) => item.artifact_kind === "assessment" && item.json_pointer === "/findings/0")?.occurrence_id as ItemOccurrenceId | undefined;
  expect(await readOccurrenceEvidence(db, tenant, both_tasks!)).toEqual([]);
  await feed.revision({ revision_id: "tasks-1", artifact_kind: "tasks", body: await fixtureBody("tasks") });
  const pinned = await readOccurrenceEvidence(db, tenant, both_tasks!);
  expect(pinned.map((set) => [set.question_id, set.task_id?.split(":").at(-1)])).toEqual([
    [CORRECTNESS_ID, "T7"], [CORRECTNESS_ID, "T8"], [EVIDENCE_SUPPORT_ID, "T7"], [EVIDENCE_SUPPORT_ID, "T8"]]);
}));

integration("a pin refuses an occurrence outside its declared target, and the refusal writes nothing", async () => scratchDatabase(async (db) => {
  await registerAll(db);
  const body = await fixtureBody("analysis");
  const relevance = OAKRIDGE_QUESTIONS.find((question) => question.question_id === RELEVANCE_ID)!;
  await createFeed(db, tenant, NO_PINS).revision({ revision_id: "analysis-1", artifact_kind: "analysis", body });
  const [finding] = await occurrences(db, "finding");
  const pin: CapturePin = { scope: "per_item", ...relevance, ...targetOf(RELEVANCE_ID), artifact_kind: "assessment", evaluator_definition_ids: [evaluatorId("grader-a")] };
  const refused = await withTenant(db, tenant, (trx) => pinSubjectInTransaction(trx, tenant, { subject: { subject_occurrence_id: finding!, task_id: null }, pin }));
  expect([refused.ok, await readOccurrenceEvidence(db, tenant, finding!)]).toEqual([false, []]);
}));
