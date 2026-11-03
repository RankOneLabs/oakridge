import { expect, test } from "bun:test";
import { sql } from "kysely";
import { canonicalDigest } from "canonical-json";
import type { ItemOccurrenceId } from "../src/domain/identity";
import { eligibilityExclusionCounts, exclusionReason, provenanceEligibility, type EligibilityDecision } from "../src/grading/eligibility";
import { recordEligibility, readEligibility } from "../src/storage/eligibility-store";
import { registerGradingContext } from "../src/storage/grading-store";
import { withTenant } from "../src/storage/database";
import { tenant, question, evidence, evaluator, scratchGrading } from "./grading-fixture";

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
integration("four exclusion causes persist as distinct typed eligibility rows", async () => scratchGrading(async (db, first) => {
  expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("code") })).ok).toBe(true);
  const ids = [first, ...[2, 3, 4].map((index) => {
    const digest = canonicalDigest(["eligibility-fixture", index]);
    if (!digest.ok) throw new Error(digest.error.detail);
    return digest.value as unknown as ItemOccurrenceId;
  })];
  await withTenant(db, tenant, async (trx) => {
    for (let index = 1; index < ids.length; index++) await sql`INSERT INTO observation.item_occurrence
      (producer, namespace, occurrence_id, revision_id, run_id, artifact_kind, schema_version, extractor_id,
       extractor_version, item_kind, item_selector, item_id_or_path, selected_value)
      VALUES (${tenant.producer}, ${tenant.namespace}, ${ids[index]}, 'rev-1', 'run-1', 'brief', '1',
        'fixture', '1', 'cohort_criterion', '/criterion', ${`criterion-${index + 1}`}, '{}'::jsonb)`.execute(trx);
  });
  const decisions: readonly EligibilityDecision[] = [
    { tag: "missing_evidence", payload: { kind: "uncited" } },
    { tag: "invalid_reference", payload: { kind: "dangling_citation", evidence_refs: ["task:absent"] } },
    { tag: "invalid_reference", payload: { kind: "unlinked" } },
    { tag: "missing_evidence", payload: { kind: "unevidenced" } },
  ];
  for (let index = 0; index < ids.length; index++) {
    const result = await recordEligibility(db, tenant, { ...decisions[index]!, producer: tenant.producer,
      namespace: tenant.namespace, subject_occurrence_id: ids[index]!, question_id: question.question_id,
      question_version: question.question_version });
    expect(result.ok).toBe(true);
  }
  const rows = await readEligibility(db, tenant, question.question_id, question.question_version);
  expect(rows.map((row) => exclusionReason(row)?.kind).sort()).toEqual([...["uncited", "dangling_citation", "unlinked", "unevidenced"] as const].sort());
  expect(eligibilityExclusionCounts(rows)).toEqual({ uncited: 1, dangling_citation: 1, unlinked: 1,
    unevidenced: 1, skipped_budget: 0 });
}));

const expected = { definition_id: "a".repeat(64), artifact_schema_version: "schema-pinned" };
test("equal definition and artifact schema are supported", () => {
  expect(provenanceEligibility(expected, expected)).toEqual({ tag: "eligible" });
});
test("a different definition is explicitly inapplicable", () => {
  expect(provenanceEligibility(expected, { ...expected, definition_id: "old-definition" })).toEqual({
    tag: "inapplicable", payload: { reason: `Unsupported provenance: definition_id: recorded="old-definition", pinned="${expected.definition_id}"` } });
});
test("a different artifact schema is explicitly inapplicable", () => {
  expect(provenanceEligibility(expected, { ...expected, artifact_schema_version: "old-schema" })).toEqual({
    tag: "inapplicable", payload: { reason: 'Unsupported provenance: artifact_schema_version: recorded="old-schema", pinned="schema-pinned"' } });
});
for (const key of ["definition_id", "artifact_schema_version"] as const) {
  test(`absent recorded ${key} is explicitly inapplicable`, () => {
    expect(provenanceEligibility(expected, { ...expected, [key]: null })).toEqual({
      tag: "inapplicable", payload: { reason: `Unsupported provenance: ${key}: recorded=null, pinned=${JSON.stringify(expected[key])}` } });
  });
}
test("a well-formed different 64-hex definition is unsupported", () => {
  const recorded = "b".repeat(64);
  expect(provenanceEligibility(expected, { ...expected, definition_id: recorded })).toEqual({
    tag: "inapplicable", payload: { reason: `Unsupported provenance: definition_id: recorded="${recorded}", pinned="${expected.definition_id}"` } });
});
