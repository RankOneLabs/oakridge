import { expect, test } from "bun:test";
import type { ItemOccurrenceId, QuestionId, EvidenceSetId } from "../src/domain/identity";
import { eligibilityExclusionCounts, exclusionReason, type EligibilityDecision } from "../src/grading/eligibility";
import { recordEligibility, readEligibility } from "../src/storage/eligibility-store";
import { registerGradingContext } from "../src/storage/grading-store";
import { withTenant } from "../src/storage/database";
import { sql } from "kysely";
import { canonicalDigest } from "../src/canonical/canonical-json";
import { tenant, question, evidence, evaluator, scratchGrading } from "./grading-fixture";
import { exclusionCounts, makePopulationManifest, type SelectedOccurrence } from "../src/langfuse/population-manifest";

test("run-slice exclusions share the eligibility denominator", async () => {
  const plan = await Bun.file(new URL("../fixtures/oakridge/run-slice/plan-revision.json", import.meta.url)).json();
  expect(plan).toBeDefined();
  const question_id = "plan.criterion_traceability" as QuestionId;
  const decisions: readonly EligibilityDecision[] = [
    { tag: "missing_evidence", payload: { kind: "uncited" } },
    { tag: "invalid_reference", payload: { kind: "dangling_citation", evidence_refs: ["task:absent"] } },
    { tag: "invalid_reference", payload: { kind: "unlinked" } },
    { tag: "missing_evidence", payload: { kind: "unevidenced" } },
  ];
  const selected: SelectedOccurrence[] = decisions.map((decision, index) => ({
    occurrence_id: `fixture-${index}` as ItemOccurrenceId, question_id, question_version: "v1",
    evidence: { evidence_set_id: `evidence-${index}` as EvidenceSetId, references: [],
      is_incomplete: false, incompleteness_reason: null },
    stratum: "known_failure", disposition: "excluded",
    reason: decision.payload as SelectedOccurrence["reason"],
  }));
  const manifest = makePopulationManifest({ manifest_id: "fixture", projection_version: "v1",
    question_pins: [{ question_id, question_version: "v1" }], selected });
  expect(manifest.ok).toBe(true);
  if (!manifest.ok) return;
  const counts = exclusionCounts(manifest.value)[0];
  const fromRows = eligibilityExclusionCounts(decisions);
  expect(counts && { uncited: counts.uncited, dangling_citation: counts.dangling_citation,
    unlinked: counts.unlinked, unevidenced: counts.unevidenced, skipped_budget: counts.skipped_budget }).toEqual(fromRows);
  expect(selected.length).toBe(Object.values(fromRows).reduce((sum, count) => sum + count, 0));
});

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
