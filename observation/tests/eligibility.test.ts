import { expect, test } from "bun:test";
import { sql } from "kysely";
import { canonicalDigest } from "canonical-json";
import type { ItemOccurrenceId } from "../src/domain/identity";
import { eligibilityExclusionCounts, exclusionReason, provenanceEligibility, type EligibilityDecision } from "../src/grading/eligibility";
import { recordEligibility, readEligibility } from "../src/storage/eligibility-store";
import { registerGradingContext } from "../src/storage/grading-store";
import { withTenant } from "../src/storage/database";
import { oakridgeQuestions } from "../src/grading/catalogue/oakridge-questions";
import { loadRunCapture } from "../src/storage/run-capture-store";
import { tenant, question, evidence, evaluator, scratchGrading, captureProjectedFixture, pilotExpectations } from "./grading-fixture";

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

integration("supported captures derive distinct exclusions exactly once and reject eligibility mutation", async () => scratchGrading(async (db) => {
  const plan = await captureProjectedFixture(db, { revision_id: "plan-eligibility", artifact_kind: "plan", body: {
    cohorts: [{ id: "cohort", decisions: [{ id: "decision", text: "source" }], acceptance_criteria: [
      { id: "uncited", text: "no source", task_ids: [], decision_ids: [] },
      { id: "dangling", text: "bad source", task_ids: [], decision_ids: ["absent"] },
      { id: "supported", text: "has source", task_ids: [], decision_ids: ["decision"] },
    ] }], acceptance_criteria: [], risks: [],
  } });
  const brief = await captureProjectedFixture(db, { revision_id: "brief-eligibility", artifact_kind: "brief", body: {
    cohort_id: "cohort", decisions_made: [], approaches_rejected: [],
    acceptance_criteria: [{ id: "unlinked", text: "no plan link" }],
  }, recorded_at: "2026-11-01T01:00:00Z" });
  const analysis = await captureProjectedFixture(db, { revision_id: "analysis-eligibility", artifact_kind: "analysis", body: {
    findings: [{ id: "finding", description: "needs excerpt", severity: "info" }], requirements: [], proposed_spec_updates: [], risks: [],
  } });
  const catalogue = oakridgeQuestions(pilotExpectations);
  for (const id of ["analysis.finding_relevance", "plan.criterion_traceability", "brief.source_fidelity", "assessment.coverage"] as const) {
    const selected = catalogue[id].definition;
    expect((await registerGradingContext(db, tenant, { question: selected, evidence, evaluator: evaluator("code") })).ok).toBe(true);
    const [first, concurrent] = await Promise.all([readEligibility(db, tenant, id, "v1"), readEligibility(db, tenant, id, "v1")]);
    expect(concurrent).toEqual(first);
    expect(await readEligibility(db, tenant, id, "v1")).toEqual(first);
  }
  const rows = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluation_eligibility").selectAll().execute());
  expect(rows).toHaveLength(6);
  const occurrenceOf = (id: string) => [...plan, ...brief].find((item) => item.item_kind === "criterion" && item.producer_local_id === id)!.occurrence_id;
  expect(rows.find((row) => row.subject_occurrence_id === occurrenceOf("uncited"))).toMatchObject({ tag: "missing_evidence", payload: { kind: "uncited" } });
  expect(rows.find((row) => row.subject_occurrence_id === occurrenceOf("dangling"))).toMatchObject({ tag: "invalid_reference", payload: { kind: "dangling_citation" } });
  expect(rows.find((row) => row.subject_occurrence_id === occurrenceOf("unlinked"))).toMatchObject({ tag: "invalid_reference", payload: { kind: "unlinked" } });
  expect(rows.find((row) => row.subject_occurrence_id === occurrenceOf("supported"))).toMatchObject({ tag: "eligible" });
  expect(rows.find((row) => row.subject_occurrence_id === analysis.find((item) => item.item_kind === "finding")!.occurrence_id))
    .toMatchObject({ tag: "missing_evidence", payload: { kind: "missing_source" } });
  expect(rows.find((row) => row.question_id === "assessment.coverage"))
    .toMatchObject({ tag: "missing_evidence", payload: { kind: "unevidenced" } });
  expect((await recordEligibility(db, tenant, { ...tenant, subject_occurrence_id: occurrenceOf("uncited") as ItemOccurrenceId,
    question_id: catalogue["plan.criterion_traceability"].definition.question_id, question_version: "v1",
    tag: "eligible", payload: { evidence_set_id: "later-evidence" } })).ok).toBe(true);
  await expect(withTenant(db, tenant, (trx) => sql`UPDATE observation.evaluation_eligibility SET tag = 'eligible'`.execute(trx)))
    .rejects.toThrow("append-only");
  await expect(withTenant(db, tenant, (trx) => sql`DELETE FROM observation.evaluation_eligibility`.execute(trx)))
    .rejects.toThrow("append-only");
  expect(await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluation_eligibility").selectAll().execute())).toEqual(rows);
  const capture = await loadRunCapture(db, tenant, "run-1");
  expect(capture.ok && capture.value.every((revision) => revision.definition_id === "definition-1" && revision.artifact_schema_version === "1")).toBe(true);
}));

integration("an unsupported pilot capture records one inapplicable decision without reading its old body", async () => scratchGrading(async (db) => {
  await captureProjectedFixture(db, { revision_id: "old-plan", artifact_kind: "plan", body: {
    cohorts: [{ id: "cohort", decisions: [], acceptance_criteria: [{ id: "old", text: "old", task_ids: [], decision_ids: [] }] }],
    acceptance_criteria: [], risks: [],
  } });
  await withTenant(db, tenant, (trx) => sql`UPDATE observation.source_revision SET definition_id = 'old-definition',
    body = '{"obsolete_layout":true}'::jsonb WHERE revision_id = 'old-plan'`.execute(trx));
  const selected = oakridgeQuestions(pilotExpectations)["plan.criterion_traceability"].definition;
  expect((await registerGradingContext(db, tenant, { question: selected, evidence, evaluator: evaluator("code") })).ok).toBe(true);
  const guarded = db.withPlugin({ transformQuery: ({ node }) => {
    if (JSON.stringify(node).includes('"name":"body"')) throw new Error("unsupported capture body was read");
    return node;
  }, transformResult: async ({ result }) => result });
  const first = await readEligibility(guarded, tenant, selected.question_id, selected.question_version);
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({ tag: "inapplicable", payload: {
    reason: 'Unsupported provenance: definition_id: recorded="old-definition", pinned="definition-1"' } });
  expect(await readEligibility(guarded, tenant, selected.question_id, selected.question_version)).toEqual(first);
  expect(await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluation_eligibility").selectAll().execute())).toHaveLength(1);
}));
