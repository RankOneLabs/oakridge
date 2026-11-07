import { expect } from "bun:test";
import { sql } from "kysely";
import type { ItemOccurrenceId } from "../src/domain/identity";
import { COLLECTION_PENDING } from "../src/grading/evidence";
import { CORRECTNESS_ID, EVIDENCE_SUPPORT_ID, OAKRIDGE_QUESTIONS, RELEVANCE_ID } from "../src/producers/oakridge/questions";
import { oakridgeProfile } from "../src/producers/oakridge/profile";
import { collectPinnedQuestion, readOccurrenceEvidence, recordCollection } from "../src/storage/captured-evidence-store";
import type { CaptureConfiguration } from "../src/grading/evidence";
import { withTenant, type Database } from "../src/storage/database";
import { registerEvaluator, registerQuestion } from "../src/storage/grading-store";
import { listRunItems, projectRevisionInTransaction } from "../src/storage/projection-store";
import { createFeed, evaluator, evaluatorId, fixtureBody, integration, scratchDatabase, tenant } from "./grading-fixture";

const pinsFor = (...evaluators: readonly string[]): CaptureConfiguration => ({ pins: OAKRIDGE_QUESTIONS.map((question) => ({
  question_id: question.question_id, question_version: question.question_version, item_kind: question.item_kind,
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
  for (const set of pinned) expect(set).toMatchObject({ question_version: "1", pinned_evaluator_definition_ids: ["grader-a", "operator"],
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
  const mismatched: CaptureConfiguration = { pins: [{ ...OAKRIDGE_QUESTIONS[1]!, item_kind: "finding", evaluator_definition_ids: [evaluatorId("grader-a")] }] };
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
  const references = [{ source: "reported", reported_by: "agent", ref: "subject", content: "cited" }] as const;
  const frozen = await recordCollection(db, tenant, support!.evidence_set_id, { state: "ready", references });
  expect(frozen.ok && frozen.value.readiness.state).toBe("ready");
  const [stillWaiting, stillReady] = await readOccurrenceEvidence(db, tenant, occurrence!);
  expect(stillWaiting?.readiness.state).toBe("not_ready");
  expect(stillReady?.readiness).toMatchObject({ state: "ready", references });
  const later = await recordCollection(db, tenant, support!.evidence_set_id,
    { state: "ready", references: [{ source: "reported", reported_by: "agent", ref: "subject", content: "replacement" }] });
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
  const source = { read: async (occurrence_id: ItemOccurrenceId) => ({ occurrence_id, run_id: "run-1", revision_id: "analysis-1",
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
