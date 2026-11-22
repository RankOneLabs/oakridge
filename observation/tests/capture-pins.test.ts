import { pinProvenance } from "./grading-fixture";
import { expect, test } from "bun:test";
import { sql } from "kysely";
import type { ArtifactRevisionId, ItemOccurrenceId, QuestionId, RunId } from "../src/domain/identity";
import { stampCapture, configurationHash, planRegistration } from "../src/grading/configuration";
import { COLLECTION_PENDING, isPinTarget, type CapturePin } from "../src/grading/evidence";
import { CONTRIBUTION_COVERAGE_ID, CORRECTNESS_ID, EVIDENCE_SUPPORT_ID, RELEVANCE_ID, TASK_COVERAGE_ID } from "./grading-fixture";
import { OAKRIDGE_QUESTIONS, fixtureDefinitions, oakridgeGradingRegistry, questionVersion, targetOf, oakridgeProfile, createFeed, evaluator, evaluatorId, fixtureBody, integration, scratchDatabase, tenant } from "./grading-fixture";
import { collectPinnedQuestion, pinSubjectInTransaction, readOccurrenceEvidence, recordCollection } from "../src/storage/captured-evidence-store";
import { NO_CAPTURE_PINS as NO_PINS, type CaptureConfiguration } from "../src/grading/evidence";
import { withTenant, type Database } from "../src/storage/database";
import { registerDefinitions, registerEvaluator, registerQuestion } from "../src/storage/grading-store";
import { listRunItems, projectRevisionInTransaction } from "../src/storage/projection-store";

const pinsFor = (...evaluators: readonly string[]): CaptureConfiguration => ({ pins: OAKRIDGE_QUESTIONS.map((question) => ({ scope: "per_item" as const,
  question_id: question.question_id, question_version: question.question_version, ...targetOf(question.question_id), ...pinProvenance(question),
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
  await feed.revision({ revision_id: "assessment-1", artifact_kind: "assessment", body: await fixtureBody("current-assessment") });
  await feed.revision({ revision_id: "analysis-1", artifact_kind: "analysis", body: await fixtureBody("analysis") });
  const [assessment] = await occurrences(db, "item_assessment");
  const pinned = await readOccurrenceEvidence(db, tenant, assessment!);
  expect(pinned.map((set) => set.question_id)).toEqual([CORRECTNESS_ID, EVIDENCE_SUPPORT_ID]);
  for (const set of pinned) expect(set).toMatchObject({ question_version: questionVersion(set.question_id), pinned_evaluator_definition_ids: ["grader-a", "operator"],
    readiness: { state: "not_ready", reason: COLLECTION_PENDING } });
  const [finding] = await occurrences(db, "finding");
  expect((await readOccurrenceEvidence(db, tenant, finding!)).map((set) => set.question_id)).toEqual([RELEVANCE_ID]);
  const [analysisRequirement] = await occurrences(db, "requirement");
  expect(await readOccurrenceEvidence(db, tenant, analysisRequirement!)).toEqual([]);
  expect(await executionCount(db)).toBe(0);
}));

integration("a pin needs a registered question and evaluator, and rejects another item kind", async () => scratchDatabase(async (db) => {
  await registerAll(db);
  const body = await fixtureBody("analysis");
  await expect(createFeed(db, tenant, pinsFor("missing-evaluator")).revision({ revision_id: "analysis-1", artifact_kind: "analysis", body }))
    .rejects.toThrow("evaluator definition that does not exist");
  await expect(createFeed(db, tenant, pinsFor("grader-a", "grader-a")).revision({ revision_id: "analysis-1", artifact_kind: "analysis", body }))
    .rejects.toThrow("pins an evaluator twice");
  const mismatched: CaptureConfiguration = { pins: [{ scope: "per_item", ...OAKRIDGE_QUESTIONS[1]!, ...targetOf(RELEVANCE_ID), ...pinProvenance(OAKRIDGE_QUESTIONS[1]!), evaluator_definition_ids: [evaluatorId("grader-a")] }] };
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
  await createFeed(db, tenant, pinsFor("grader-a", "operator")).revision({ revision_id: "assessment-1", artifact_kind: "assessment", body: await fixtureBody("current-assessment") });
  const [occurrence] = await occurrences(db, "item_assessment");
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
  const registration = planRegistration(await fixtureDefinitions(), oakridgeGradingRegistry);
  if (!registration.ok) throw new Error(registration.error.detail);
  const registered = await registerDefinitions(db, tenant, registration.value);
  if (!registered.ok) throw new Error(registered.error.detail);
  return { ...registration.value, capture: stampCapture(registration.value.capture, { config_version: 1, config_hash: "canonical-json/v1:" + "a".repeat(64) }) };
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
  for (const [index, artifact_kind] of ["analysis", "spec", "plan", "brief", "build_result", "assessment"].entries()) {
    const file = artifact_kind === "build_result" ? "build-result" : `current-${artifact_kind}`;
    await feed.revision({ revision_id: `${artifact_kind}-1`, artifact_kind, body: await fixtureBody(file),
      recorded_at: `2026-11-01T00:00:0${index}Z`,
      ...(artifact_kind === "assessment" ? { subject_id: "build_result-1",
        input_bindings: [{ input: "reviewed", unit: "brief", revision_id: "brief-1" }] } : {}) });
  }
}

test("a pin's target is its artifact, selector and item kind together", () => {
  const plan = { artifact_kind: "plan", item_selector: "/cohorts/*/allocations/*", item_kind: "allocation" };
  expect([
    isPinTarget(plan, plan),
    isPinTarget(plan, { ...plan, artifact_kind: "brief", item_selector: "/build_items/*" }),
    isPinTarget(plan, { ...plan, item_selector: "/build_items/*" }),
    isPinTarget(plan, { ...plan, item_kind: "decision" }),
  ]).toEqual([true, false, false, false]);
});

integration("plan allocations are pinned only by their declared targets", async () => scratchDatabase(async (db) => {
  const registration = await committedCapture(db);
  await captureEveryArtifact(createFeed(db, tenant, registration.capture));
  const pinned = await pinnedByTarget(db);
  expect([pinned["plan /cohorts/*/allocations/*"], pinned["brief /build_items/*"]]).toEqual([[CONTRIBUTION_COVERAGE_ID], []]);
}));

integration("every captured item is pinned exactly the questions whose declared target is its artifact and selector", async () => scratchDatabase(async (db) => {
  const registration = await committedCapture(db);
  await captureEveryArtifact(createFeed(db, tenant, registration.capture));
  expect(await pinnedByTarget(db)).toEqual({
    "analysis /requirements/*/findings/*": [RELEVANCE_ID],
    "analysis /requirements/*": [],
    "assessment /item_assessments/*": [CORRECTNESS_ID, EVIDENCE_SUPPORT_ID],
    "assessment /additional_findings/*": [],
    "assessment /proposals/*": [],
    "brief /build_items/*": [],
    "brief /technical_decisions/*": [],
    "plan /cohorts/*/allocations/*": [CONTRIBUTION_COVERAGE_ID],
    "spec /requirements/*": [TASK_COVERAGE_ID],
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
  await feed.revision({ revision_id: "brief-1", artifact_kind: "brief", body: await fixtureBody("current-brief") });
  await feed.revision({ revision_id: "assessment-1", artifact_kind: "assessment", body: await fixtureBody("current-assessment"),
    input_bindings: [{ input: "reviewed", unit: "brief", revision_id: "brief-1" }] });
  const both_tasks = (await listRunItems(db, tenant, "run-1", { limit: 200, offset: 0 })).items
    .find((item) => item.artifact_kind === "assessment" && item.json_pointer === "/item_assessments/0")?.occurrence_id as ItemOccurrenceId | undefined;
  expect(await readOccurrenceEvidence(db, tenant, both_tasks!)).toEqual([]);
  await feed.revision({ revision_id: "spec-1", artifact_kind: "spec", body: await fixtureBody("current-spec") });
  const pinned = await readOccurrenceEvidence(db, tenant, both_tasks!);
  expect(pinned.map((set) => [set.question_id, set.task_id?.split(":").at(-1)])).toEqual([
    [CORRECTNESS_ID, "R1"], [CORRECTNESS_ID, "R3"], [EVIDENCE_SUPPORT_ID, "R1"], [EVIDENCE_SUPPORT_ID, "R3"]]);
}));

integration("a pin refuses an occurrence outside its declared target, and the refusal writes nothing", async () => scratchDatabase(async (db) => {
  await registerAll(db);
  const body = await fixtureBody("analysis");
  const relevance = OAKRIDGE_QUESTIONS.find((question) => question.question_id === RELEVANCE_ID)!;
  await createFeed(db, tenant, NO_PINS).revision({ revision_id: "analysis-1", artifact_kind: "analysis", body });
  const [finding] = await occurrences(db, "finding");
  const pin: CapturePin = { scope: "per_item", ...relevance, ...targetOf(RELEVANCE_ID), ...pinProvenance(OAKRIDGE_QUESTIONS.find((q) => q.question_id === RELEVANCE_ID)!), artifact_kind: "assessment", evaluator_definition_ids: [evaluatorId("grader-a")] };
  const refused = await withTenant(db, tenant, (trx) => pinSubjectInTransaction(trx, tenant, { subject: { subject_occurrence_id: finding!, task_id: null }, pin }));
  expect([refused.ok, await readOccurrenceEvidence(db, tenant, finding!)]).toEqual([false, []]);
}));

test("every fixture question target has a capture pin", async () => {
  const { fixtureDefinitions, oakridgeGradingRegistry } = await import("./grading-fixture");
  const { planRegistration } = await import("../src/grading/configuration");
  const registration = planRegistration(await fixtureDefinitions(), oakridgeGradingRegistry);
  if (!registration.ok) throw new Error(registration.error.detail);
  expect(registration.value.capture.pins).toMatchObject([
    { question_id: "finding.relevance", item_kind: "finding", artifact_kind: "analysis", item_selector: "/requirements/*/findings/*" },
    { question_id: "assessment_finding.correctness", item_kind: "item_assessment", artifact_kind: "assessment", item_selector: "/item_assessments/*" },
    { question_id: "assessment_finding.evidence_support", item_kind: "item_assessment", artifact_kind: "assessment", item_selector: "/item_assessments/*" },
    { question_id: "task.requirement_coverage", item_kind: "requirement", artifact_kind: "spec", item_selector: "/requirements/*" },
    { question_id: "acceptance_entry.task_coverage", item_kind: "allocation", artifact_kind: "plan", item_selector: "/cohorts/*/allocations/*" },
  ]);
});

integration("canonical development items freeze every configured evidence reference family", async () => scratchDatabase(async (db) => {
  const { fixtureDefinitions, oakridgeGradingRegistry } = await import("./grading-fixture");
  const { planRegistration } = await import("../src/grading/configuration");
  const { registerDefinitions } = await import("../src/storage/grading-store");
  const { CaptureArtifactSource } = await import("../src/storage/capture-artifact-source");
  const registration = planRegistration(await fixtureDefinitions(), oakridgeGradingRegistry);
  if (!registration.ok) throw new Error(registration.error.detail);
  await registerDefinitions(db, tenant, registration.value);
  const feed = createFeed(db, tenant, stampCapture(registration.value.capture, { config_version: 1, config_hash: "canonical-json/v1:" + "a".repeat(64) }));
  await feed.launch({ spec: "The whole spec", repositories: [{ key: "oakridge", preparation: { repository_path: "/fixture" } }] });
  await captureEveryArtifact(feed);
  const source = new CaptureArtifactSource({ db, tenant, run_id: "run-1", collector: registration.value.collector,
    repository: { hasCommit: async () => true, readFile: async () => ({ state: "present", content: "one\ntwo\nthree" }) } });
  const items = (await listRunItems(db, tenant, "run-1", { limit: 200, offset: 0 })).items;
  const families = {
    "finding.relevance": ["subject", "spec"],
    "assessment_finding.correctness": ["subject", "build_result", "test_evidence", "task_context"],
    "assessment_finding.evidence_support": ["subject", "test_evidence", "task_context"],
    "task.requirement_coverage": ["subject", "spec", "spec_task", "requirement"],
    "acceptance_entry.task_coverage": ["subject", "requirement", "spec_task", "plan"],
  };
  for (const item of items) {
    const pins = registration.value.capture.pins.filter((pin) => pin.artifact_kind === item.artifact_kind && pin.item_selector === item.item_selector);
    const sets = await readOccurrenceEvidence(db, tenant, item.occurrence_id as ItemOccurrenceId);
    const expected = [...new Set(pins.map((pin) => pin.question_id))].sort();
    expect([...new Set(sets.map((set) => set.question_id))].sort()).toEqual(expected);
    for (const set of sets) {
      const collected = await collectPinnedQuestion(db, tenant, source, set);
      if (!collected.ok || collected.value.readiness.state !== "ready") throw new Error(JSON.stringify(collected));
      const references = collected.value.readiness.references;
      const names = [...new Set(references.map((reference) => reference.ref.split(":")[0]!))];
      expect(names).toEqual(families[set.question_id as keyof typeof families]);
      expect(references[0]).toMatchObject({ ref: "subject", revision_id: item.revision_id, item_path: item.json_pointer, content: item.selected_value });
    }
  }
}));

test("stampCapture binds every plan to one published identity and disables unpublished captures", async () => {
  const registration = planRegistration(await fixtureDefinitions(), oakridgeGradingRegistry);
  if (!registration.ok) throw new Error(registration.error.detail);
  const identity = { config_version: 3, config_hash: "canonical-json/v1:" + "a".repeat(64) };
  expect(stampCapture(registration.value.capture, identity).pins).toEqual(
    registration.value.capture.pins.map((pin) => ({ ...pin, ...identity })));
  expect(stampCapture(registration.value.capture, null)).toEqual(NO_PINS);
});

integration("later publication and redelivery preserve the original pin attribution", async () => scratchDatabase(async (db) => {
  const definitions = await fixtureDefinitions();
  const hash = configurationHash(definitions);
  if (!hash.ok) throw new Error(hash.error.detail);
  const registration = await committedCapture(db);
  const first = stampCapture(registration.capture, { config_version: 1, config_hash: hash.value });
  const second = stampCapture(registration.capture, { config_version: 2, config_hash: "canonical-json/v1:" + "b".repeat(64) });
  const feed = createFeed(db, tenant, first);
  const body = await fixtureBody("analysis");
  await feed.revision({ revision_id: "analysis-1", artifact_kind: "analysis", body });
  const before = await Promise.all((await occurrences(db, "finding")).map((id) => readOccurrenceEvidence(db, tenant, id)));
  expect(before.flat().length).toBeGreaterThan(0);
  for (const set of before.flat()) {
    expect([set.config_version, set.config_hash, set.collection_plan]).toEqual([1, hash.value,
      first.pins.find((pin) => pin.question_id === set.question_id)!.collection_plan]);
  }
  await feed.revision({ revision_id: "analysis-2", artifact_kind: "analysis", body }, second);
  const items = (await listRunItems(db, tenant, "run-1", { limit: 200, offset: 0 })).items;
  const later = items.filter((item) => item.revision_id === "analysis-2" && item.item_kind === "finding");
  expect(later.length).toBeGreaterThan(0);
  for (const item of later) for (const set of await readOccurrenceEvidence(db, tenant, item.occurrence_id as ItemOccurrenceId))
    expect([set.config_version, set.config_hash]).toEqual([2, second.pins[0]!.config_hash]);
  await feed.revision({ revision_id: "analysis-1", artifact_kind: "analysis", body }, second);
  const after = await Promise.all(before.map((sets) => readOccurrenceEvidence(db, tenant, sets[0]!.subject_occurrence_id)));
  expect(after).toEqual(before);
}));

test("evidenceRead retains the stored configuration and plan", async () => {
  const { evidenceRead } = await import("../src/grading/item-reads");
  const { evidence, occurrence, revision } = await import("./rollup-fixture");
  const set = evidence(occurrence("one", revision("r", "analysis")), null);
  const read = evidenceRead(set, { references: { limit: 10, offset: 0 }, pinned_evaluators: { limit: 10, offset: 0 } });
  expect([read.config_version, read.config_hash, read.collection_plan]).toEqual([set.config_version, set.config_hash, set.collection_plan]);
});
