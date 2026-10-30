import { expect, test } from "bun:test";
import type { ItemOccurrenceId, QuestionId, EvidenceSetId } from "../src/domain/identity";
import type { JsonValue } from "../src/domain/primitives";
import type { CapturedRevision } from "../src/grading/evidence-packages/capture";
import { eligibilityExclusionCounts, exclusionReason, type EligibilityDecision } from "../src/grading/eligibility";
import { recordEligibility, readEligibility } from "../src/storage/eligibility-store";
import { registerGradingContext } from "../src/storage/grading-store";
import { withTenant } from "../src/storage/database";
import { sql } from "kysely";
import { canonicalDigest } from "../src/canonical/canonical-json";
import { tenant, question, evidence, evaluator, scratchGrading } from "./grading-fixture";
import { exclusionCounts, makePopulationManifest, type SelectedOccurrence } from "../src/langfuse/population-manifest";
import { oakridgeDevelopmentCatalogue } from "../src/projection/catalogue/oakridge-development";
import { selectRevision } from "../src/projection/extractor";
import { runPackages } from "../src/producers/oakridge/evidence-packages";

async function captured(kind: string, revision_id: string, at: string): Promise<CapturedRevision> {
  const body = await Bun.file(new URL(`../fixtures/oakridge/run-slice/${kind}-revision.json`, import.meta.url)).json() as JsonValue;
  const selected = selectRevision(body, revision_id, oakridgeDevelopmentCatalogue(kind, "1"));
  return { revision_id, unit_id: kind, artifact_kind: kind, recorded_at: new Date(at),
    items: selected.items.map(({ item }, index) => ({ ...item, occurrence_id: `${revision_id}-${index}` as ItemOccurrenceId,
      revision_id })) };
}

test("run-slice exclusions share the eligibility denominator", async () => {
  const plan = await captured("plan", "plan-first", "2026-10-23T17:23:49Z");
  const badPlan: CapturedRevision = { ...plan, revision_id: "plan-bad", recorded_at: new Date("2026-10-23T17:25:00Z"),
    items: plan.items.map((item, index) => ({ ...item, occurrence_id: `plan-bad-${index}` as ItemOccurrenceId,
      revision_id: "plan-bad", links: item.item_kind === "criterion" && item.producer_local_id === "criterion-lineage"
        ? item.links.map((link) => ({ ...link, target_local_id: "absent-decision" })) : item.links })) };
  const brief = await captured("brief", "brief-first", "2026-10-23T17:29:56Z");
  const assessment = await captured("assessment", "assessment-first", "2026-10-23T17:35:00Z");
  const unlinkedBrief: CapturedRevision = { ...brief, revision_id: "brief-unlinked",
    recorded_at: new Date("2026-10-23T17:40:00Z"), items: brief.items.map((item, index) => ({ ...item,
      occurrence_id: `brief-unlinked-${index}` as ItemOccurrenceId, revision_id: "brief-unlinked",
      links: item.item_kind === "criterion" ? [] : item.links })) };
  const built = runPackages([plan, badPlan, brief, assessment, unlinkedBrief]);
  expect(built.ok).toBe(true);
  if (!built.ok) return;
  const selected: SelectedOccurrence[] = built.value.eligibility.map((row) => {
    const packaged = built.value.packages.find((candidate) => candidate.question_id === row.question_id
      && candidate.subject.occurrence_id === row.occurrence_id);
    const reason = exclusionReason(row.decision);
    if (row.decision.tag !== "eligible" && !reason) throw new Error("fixture decision has no population reason");
    return { occurrence_id: row.occurrence_id, question_id: row.question_id as QuestionId, question_version: "v1",
      evidence: packaged?.evidence ?? { evidence_set_id: `${row.occurrence_id}-${row.question_id}` as EvidenceSetId,
        references: [], is_incomplete: false, incompleteness_reason: null },
      stratum: "known_failure", disposition: reason ? "excluded" : "included",
      reason: reason ?? { kind: "operator", detail: "included by fixture selection" } };
  });
  const question_pins = [...new Set(selected.map((item) => item.question_id))]
    .map((question_id) => ({ question_id, question_version: "v1" }));
  const manifest = makePopulationManifest({ manifest_id: "fixture", projection_version: "v1",
    question_pins, selected });
  expect(manifest.ok).toBe(true);
  if (!manifest.ok) return;
  expect(manifest.value.membership.length).toBe(built.value.eligibility.length);
  const counts = exclusionCounts(manifest.value);
  for (const pin of question_pins) {
    const fromRows = eligibilityExclusionCounts(built.value.eligibility
      .filter((row) => row.question_id === pin.question_id).map((row) => row.decision));
    const counted = counts.find((row) => row.question_id === pin.question_id);
    expect(counted && { uncited: counted.uncited, dangling_citation: counted.dangling_citation,
      unlinked: counted.unlinked, unevidenced: counted.unevidenced, skipped_budget: counted.skipped_budget }).toEqual(fromRows);
    const included = selected.filter((row) => row.question_id === pin.question_id && row.disposition === "included").length;
    expect(manifest.value.membership.filter((row) => row.question_id === pin.question_id).length)
      .toBe(included + Object.values(fromRows).reduce((sum, count) => sum + count, 0));
  }
  expect(new Set(built.value.eligibility.map((row) => exclusionReason(row.decision)?.kind).filter(Boolean)))
    .toEqual(new Set(["uncited", "dangling_citation", "unlinked", "unevidenced"]));
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
