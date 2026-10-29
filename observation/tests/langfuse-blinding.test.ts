import { expect, test } from "bun:test";
import { LANGFUSE_PILOT_QUESTIONS } from "../src/grading/catalogue/langfuse-pilot";
import { blindEvidence, selectBlindSample, separateLabelSeries } from "../src/langfuse/blinding";
import { listGrades } from "../src/storage/grading-store";
import { storeHumanGradeInTransaction } from "../src/storage/backfill-store";
import { withTenant } from "../src/storage/database";
import { scratchGrading, tenant } from "./grading-fixture";
import { createApp } from "../src/http/app";

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;

integration("Oakridge operator verdicts carry an observation origin and remain outside held-out labels", async () =>
  scratchGrading(async (db, occurrence_id) => {
    await withTenant(db, tenant, (trx) => storeHumanGradeInTransaction(trx, tenant, {
      format: "observation.source-event/v1", definition_bundle: null, artifact_schema_version: null,
      kind: "human_grade", event_kind: "operator_decided", run_id: "run-1", event_id: "event-1",
      decision_id: "decision-1", evaluator: { kind: "human" }, unit: "unit-1", review: "assessment",
      decision: "approve", target: "rev-1", feedback: { reason: "approved" }, effect: "approve",
      decided_at: "2026-10-29T10:00:00.000Z",
    }));
    const page = await listGrades(db, tenant, occurrence_id, { limit: 20, offset: 0 });
    const grade = page?.items[0]?.observation;
    expect(grade).toMatchObject({ question_id: "oakridge-review:assessment:cohort_criterion",
      question_version: "1", evaluator_definition_id: "oakridge-operator-human",
      reviewer_id: "oakridge-operator", label_origin: "oakridge_operator_unblinded" });
    const series = separateLabelSeries(page?.items.map((item) => item.observation) ?? [], [
      { event_id: "thread-1", revision_id: "rev-1", anchor: "/criterion",
        body: { comment: "unblinded operator discussion" } },
    ]);
    expect(series.held_out).toHaveLength(0);
    expect(series.oakridge_operator_unblinded.map((item) => item.observation_id)).toEqual(grade ? [grade.observation_id] : []);
    expect(series.collaboration_unblinded).toHaveLength(1);
    const app = createApp({ db, credentials: { ingest: [], grade: [], read: [{ ...tenant, token: "read" }] } });
    const response = await app.request("/v1/langfuse/label-series", { headers: { Authorization: "Bearer read" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ held_out: { count: 0 },
      oakridge_operator_unblinded: { count: 1 } });
  }));

test("blinded evidence contains no original verdict and declares whether it grades report or code", () => {
  const question = LANGFUSE_PILOT_QUESTIONS["analysis.finding_relevance"].definition;
  const source = [
    { role: "requested_change" as const, ref: "revision/request", digest: "request", deep_link: "https://example.test/request",
      assessor_verdict: "approve", decision: "approve", effect: "approve" },
    { role: "relevant_excerpt" as const, ref: "revision/excerpt", digest: "excerpt", deep_link: "https://example.test/excerpt" },
    { role: "analysis_finding" as const, ref: "revision/finding", digest: "finding", deep_link: "https://example.test/finding" },
  ];
  const packageResult = blindEvidence(question, source, "report");
  expect(packageResult.ok).toBe(true);
  if (!packageResult.ok) return;
  expect(packageResult.value.graded_artifact).toBe("report");
  expect(JSON.stringify(packageResult.value)).not.toMatch(/assessor_verdict|"decision"|"effect"|approve/);
  expect(blindEvidence(question, [{ ...source[0]!, ref: "revision/verdict" }, ...source.slice(1)], "code"))
    .toMatchObject({ ok: false, error: { operation: "blind_evidence" } });
});

test("stratified sample selection depends on pinned candidate properties and contains required failure cases", () => {
  const candidates = [
    { occurrence_id: "easy-1", stratum: "clearly_easy" as const, has_split_criterion: false,
      has_false_verified_claim: false, operator_verdict: "approve" },
    { occurrence_id: "border-1", stratum: "borderline" as const, has_split_criterion: true,
      has_false_verified_claim: false, operator_verdict: "request_changes" },
    { occurrence_id: "failure-1", stratum: "known_failure" as const, has_split_criterion: false,
      has_false_verified_claim: true, operator_verdict: "approve" },
  ];
  const plan = { per_stratum: { clearly_easy: 1, borderline: 1, known_failure: 1 } };
  const selected = selectBlindSample(candidates, plan);
  const changedVerdicts = selectBlindSample(candidates.map((candidate) => ({ ...candidate, operator_verdict: "opposite" })), plan);
  expect(selected.ok && selected.value.map((candidate) => candidate.occurrence_id)).toEqual(
    changedVerdicts.ok && changedVerdicts.value.map((candidate) => candidate.occurrence_id));
  expect(selected.ok && selected.value.map((candidate) => candidate.stratum)).toEqual([
    "clearly_easy", "borderline", "known_failure"]);
  expect(selectBlindSample(candidates, { per_stratum: { ...plan.per_stratum, borderline: 0 } })).toMatchObject({ ok: false });
});
