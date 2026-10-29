import { expect, test } from "bun:test";
import type { CanonicalDigest, EvidenceSetId, ExecutionId, GradeObservationId, ItemOccurrenceId, QuestionId } from "../src/domain/identity";
import type { ExportManifest } from "../src/export/manifest";
import type { EvaluationExecution } from "../src/grading/execution";
import type { GradeObservation } from "../src/grading/observation";
import { makeComparisonReport, type ComparisonMeasurement } from "../src/langfuse/comparison-report";
import { assayItemEvidenceDigest, makePopulationManifest, type PopulationMember } from "../src/langfuse/population-manifest";

const question_id = "analysis.finding_relevance" as QuestionId;
const occurrence_id = "occ-1" as ItemOccurrenceId;
const evidence_set_id = "evidence-1" as EvidenceSetId;
const selected = { occurrence_id, question_id, question_version: "v1", stratum: "borderline" as const,
  disposition: "included" as const, reason: "revisioned borderline finding",
  evidence: { evidence_set_id, references: [{ ref: "revision:1", kind: "public" as const,
    content: { excerpt: "pinned" }, digest: null }], is_incomplete: false, incompleteness_reason: null } };
const manifestResult = makePopulationManifest({ manifest_id: "population-1", projection_version: "v1",
  question_pins: [{ question_id, question_version: "v1" }], selected: [selected] });
if (!manifestResult.ok) throw new Error(manifestResult.error.detail);
const manifest = manifestResult.value;
const member = manifest.membership[0]!;

function execution(attempt_label: string, status: EvaluationExecution["status"] = "completed",
  question_version = "v1"): EvaluationExecution {
  return { execution_id: `execution-${attempt_label}` as ExecutionId, subject_occurrence_id: occurrence_id,
    evidence_set_id, question_id, question_version, evaluator_definition_id: "jev-v1", config_digest: "config-v1",
    attempt_label, idempotency_digest: `digest-${attempt_label}`, attempts: 1, retries: 0,
    started_at: new Date("2026-10-29T10:00:00.000Z"), ended_at: new Date("2026-10-29T10:00:00.125Z"),
    status, error: status === "failed" ? "upstream unavailable" : null, model_usage: null, cost: 0.002,
    external_execution_id: null, provider_link: null, reproducibility_metadata: null };
}
function observation(id: string, policy = false): GradeObservation {
  return { observation_id: id as GradeObservationId,
    answer: { state: "answered", kind: "choice", value: "relevant" },
    probabilities: { relevant: 0.7, irrelevant: 0.2, insufficient_evidence: 0.1 }, confidence: 0.61,
    normalized_score: policy ? 1 : null, decision_policy_id: policy ? "decision-v1" : null,
    decision_policy_version: policy ? "v1" : null, reviewer_id: null, reviewer_details: null,
    comments: null, rationale: null, quality_flags: [], supersedes_observation_id: null };
}
function measurement(attempt_label: string, run: EvaluationExecution | null,
  grade: GradeObservation | null, overrides: Partial<ComparisonMeasurement> = {}): ComparisonMeasurement {
  return { member, split: "exploratory", evaluator_version: "jev-prompt-v1", attempt_label,
    execution: run, observation: grade, human_label: { answer: { state: "answered", kind: "choice", value: "irrelevant" },
      origin: "langfuse_annotation_blinded", reviewer_id: "reviewer-1" },
    disagreement_cause: "machine_disagreement", ...overrides };
}

test("missing and failed executions remain in the denominator with their own states", () => {
  const report = makeComparisonReport(manifest, [measurement("missing", null, null),
    measurement("failed", execution("failed", "failed"), null),
    measurement("answered", execution("answered"), observation("grade-1"))]);
  if (!report.ok) throw new Error(report.error.detail);
  expect(report.value.groups[0]).toMatchObject({ denominator: 3, missing: 1, failed: 1, answered: 1,
    label_agreement: { compared: 1, agreed: 0 } });
  expect(report.value.groups[0]!.rows.map((row) => row.state)).toEqual(["missing", "failed", "answered"]);
});

test("group key includes question version, evidence, population and evaluator version; attempts stay distinct", () => {
  const second = measurement("second", execution("second"), observation("grade-2"));
  const differentEvaluator = measurement("third", execution("third"), observation("grade-3"),
    { evaluator_version: "jev-prompt-v2" });
  const report = makeComparisonReport(manifest, [measurement("first", execution("first"), observation("grade-1")),
    second, differentEvaluator]);
  if (!report.ok) throw new Error(report.error.detail);
  expect(report.value.groups.map((group) => [group.key.question_id, group.key.question_version,
    group.key.evidence_set_digest, group.key.population_manifest_id, group.key.evaluator_version])).toEqual([
    [question_id, "v1", member.evidence_set_digest, "population-1", "jev-prompt-v1"],
    [question_id, "v1", member.evidence_set_digest, "population-1", "jev-prompt-v2"],
  ]);
  expect(report.value.groups[0]!.rows.map((row) => [row.attempt_label, row.execution_id, row.observation_id])).toEqual([
    ["first", "execution-first", "grade-1"], ["second", "execution-second", "grade-2"],
  ]);
  const changedEvidence = { ...member, evidence_set_digest: `canonical-json/v1:${"b".repeat(64)}` as CanonicalDigest };
  expect(makeComparisonReport(manifest, [measurement("other", execution("other"), null, { member: changedEvidence })]))
    .toMatchObject({ ok: false });
});

test("question version, evidence set and population pin produce separate group identities", () => {
  const secondEvidence = { ...selected.evidence, evidence_set_id: "evidence-2" as EvidenceSetId,
    references: [{ ref: "revision:2", kind: "public" as const, content: { excerpt: "changed" }, digest: null }] };
  const selectedV2 = { ...selected, question_version: "v2", evidence: secondEvidence };
  const multi = makePopulationManifest({ manifest_id: "population-multi", projection_version: "v1",
    question_pins: [{ question_id, question_version: "v1" }, { question_id, question_version: "v2" }],
    selected: [selected, selectedV2] });
  if (!multi.ok) throw new Error(multi.error.detail);
  const firstMember = multi.value.membership.find((entry) => entry.question_version === "v1")!;
  const secondMember = multi.value.membership.find((entry) => entry.question_version === "v2")!;
  const rows = [measurement("one", execution("one"), observation("grade-one"), { member: firstMember }),
    measurement("two", execution("two", "completed", "v2"), observation("grade-two"), { member: secondMember })];
  const report = makeComparisonReport(multi.value, rows);
  if (!report.ok) throw new Error(report.error.detail);
  expect(new Set(report.value.groups.map((group) => `${group.key.question_version}:${group.key.evidence_set_digest}`)))
    .toEqual(new Set([`v1:${firstMember.evidence_set_digest}`, `v2:${secondMember.evidence_set_digest}`]));
  const replay = makePopulationManifest({ manifest_id: "population-next", projection_version: "v1",
    question_pins: [{ question_id, question_version: "v1" }], selected: [selected] });
  if (!replay.ok) throw new Error(replay.error.detail);
  const replayReport = makeComparisonReport(replay.value, [measurement("one", execution("one"),
    observation("grade-one"), { member: replay.value.membership[0]! })]);
  if (!replayReport.ok) throw new Error(replayReport.error.detail);
  expect(replayReport.value.groups[0]!.key.population_manifest_id).toBe("population-next");
});

test("raw probabilities and confidence survive; normalized score needs a pinned policy", () => {
  const report = makeComparisonReport(manifest, [measurement("first", execution("first"), observation("grade-1")),
    measurement("second", execution("second"), observation("grade-2", true))]);
  if (!report.ok) throw new Error(report.error.detail);
  expect(report.value.groups[0]!.rows.map((row) => ({ probabilities: row.probabilities, confidence: row.confidence,
    normalized_score: row.normalized_score, decision_policy_id: row.decision_policy_id,
    decision_policy_version: row.decision_policy_version }))).toEqual([
    { probabilities: { relevant: 0.7, irrelevant: 0.2, insufficient_evidence: 0.1 }, confidence: 0.61,
      normalized_score: null, decision_policy_id: null, decision_policy_version: null },
    { probabilities: { relevant: 0.7, irrelevant: 0.2, insufficient_evidence: 0.1 }, confidence: 0.61,
      normalized_score: 1, decision_policy_id: "decision-v1", decision_policy_version: "v1" },
  ]);
  expect(makeComparisonReport(manifest, [measurement("bad", execution("bad"),
    { ...observation("bad-grade"), normalized_score: 1 })])).toMatchObject({ ok: false });
});

test("population digest is order independent and included item/evidence digest matches Assay", () => {
  const another = { ...selected, occurrence_id: "occ-2" as ItemOccurrenceId, stratum: "known_failure" as const };
  const first = makePopulationManifest({ manifest_id: "population-2", projection_version: "v1",
    question_pins: [{ question_id, question_version: "v1" }], selected: [selected, another] });
  const replay = makePopulationManifest({ manifest_id: "population-2", projection_version: "v1",
    question_pins: [{ question_id, question_version: "v1" }], selected: [another, selected] });
  if (!first.ok || !replay.ok) throw new Error("manifest failed");
  expect(first.value.membership_digest).toBe(replay.value.membership_digest);
  const assay = { manifest_id: "assay-1", membership: first.value.membership.map((entry: PopulationMember) => ({
    ...entry, candidate_id: `canonical-json/v1:${"a".repeat(64)}` as CanonicalDigest,
    revision_id: "revision-1", revision_digest: `canonical-json/v1:${"c".repeat(64)}`,
    evidence_set_id, observation_id: "grade-1", redaction_reasons: [],
  })) } as unknown as ExportManifest;
  expect(assayItemEvidenceDigest(assay)).toEqual({ ok: true, value: first.value.shared_item_evidence_digest });
});
