import { expect, test } from "bun:test";
import type { GradeObservationId } from "../src/domain/identity";
import * as gradingStore from "../src/storage/grading-store";
import { sql } from "kysely";
import { withTenant } from "../src/storage/database";
import { tenant, question, evidence, evaluator, scratchGrading } from "./grading-fixture";
const integration = process.env.OAKRIDGE_TEST_DATABASE_URL || process.env.CI === "true" ? test : test.skip;

test("the store has no grade update or delete API", () => {
  expect("updateGrade" in gradingStore).toBe(false);
  expect("deleteGrade" in gradingStore).toBe(false);
});

test("grading schema has no consensus, aggregate, ground truth, latest, or accepted column", async () => {
  const schema = await Bun.file(new URL("../src/storage/migrations/0003_grading.sql", import.meta.url)).text();
  const columns = [...schema.matchAll(/^  (\w+) (?:text|jsonb|boolean|numeric|double precision|integer|bigint|timestamptz)\b/gm)].map((match) => match[1]);
  for (const forbidden of ["consensus", "aggregate", "ground_truth", "latest", "accepted"])
    expect(columns.some((column) => column.includes(forbidden))).toBe(false);
});

integration("three evaluators coexist and a human correction leaves its predecessor unchanged", async () => scratchGrading(async (db, occurrence_id) => {
  for (const kind of ["code", "model", "human"] as const) {
    const registered = await gradingStore.registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator(kind) });
    expect(registered.ok).toBe(true);
  }
  const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
    question_id: question.question_id, question_version: question.question_version, config_digest: "config-1", attempt_label: "first" };
  for (const kind of ["code", "model"] as const) {
    const result = await gradingStore.runGrade(db, tenant, { identity: { ...identity, evaluator_definition_id: kind },
      runner: { kind, run: async () => ({ ok: true, value: { answer: { state: "answered", kind: "boolean", value: kind === "code" } } }) } });
    expect(result.ok).toBe(true);
  }
  const details = { answer: { state: "answered", kind: "boolean", value: false } as const,
    probabilities: null, confidence: null, normalized_score: null, decision_policy_id: null,
    decision_policy_version: null, reviewer_id: "reviewer-1", reviewer_details: null,
    comments: null, rationale: null, quality_flags: [], supersedes_observation_id: null };
  const first = await gradingStore.recordHumanGrade(db, tenant, { ...identity, evaluator_definition_id: "human", details });
  expect(first.ok).toBe(true);
  if (!first.ok || !first.value.observation) throw new Error("missing first human observation");
  const beforePage = await gradingStore.listGrades(db, tenant, occurrence_id, { limit: 10, offset: 0 });
  const beforeObservation = beforePage?.items.find((item) => item.observation.observation_id === first.value.observation?.observation_id)?.observation;
  if (!beforeObservation) throw new Error("missing first human observation on grades read");
  const before = JSON.stringify(beforeObservation);
  const correction = await gradingStore.recordHumanGrade(db, tenant, { ...identity, evaluator_definition_id: "human",
    attempt_label: "correction", details: { ...details, answer: { state: "answered", kind: "boolean", value: true },
      supersedes_observation_id: first.value.observation.observation_id as GradeObservationId } });
  expect(correction.ok).toBe(true);
  const listed = await gradingStore.listGrades(db, tenant, occurrence_id, { limit: 10, offset: 0 });
  expect(listed?.items).toHaveLength(4);
  expect(new Set(listed?.items.map((item) => item.evaluator.kind))).toEqual(new Set(["code", "model", "human"]));
  expect(JSON.stringify(listed?.items.find((item) => item.observation.observation_id === first.value.observation?.observation_id)?.observation)).toBe(before);
  expect(correction.ok && correction.value.observation?.supersedes_observation_id).toBe(first.value.observation.observation_id);
  await expect(withTenant(db, tenant, (trx) => sql`UPDATE observation.grade_observation SET comments = 'rewritten'
    WHERE observation_id = ${first.value.observation!.observation_id}`.execute(trx))).rejects.toThrow("append-only");
}));
