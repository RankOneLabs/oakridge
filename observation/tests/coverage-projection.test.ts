import { expect, test } from "bun:test";
import { sql } from "kysely";
import type { CoverageProjection } from "../src/grading/coverage";
import { createApp } from "../src/http/app";
import { withTenant } from "../src/storage/database";
import { readCoverage } from "../src/storage/coverage-store";
import { registerGradingContext } from "../src/storage/grading-store";
import { canonicalDigest } from "canonical-json";
import { question, evidence, evaluator, scratchGrading, tenant } from "./grading-fixture";

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
integration("coverage uses recorded eligibility and keeps successive revisions separate", async () => scratchGrading(async (db, occurrence_id) => {
  expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("human") })).ok).toBe(true);
  const currentDigest = canonicalDigest(["current-occurrence"]);
  const excludedDigest = canonicalDigest(["excluded-occurrence"]);
  const missingDigest = canonicalDigest(["missing-occurrence"]);
  if (!currentDigest.ok || !excludedDigest.ok || !missingDigest.ok) throw new Error("fixture digest failed");
  const currentId = currentDigest.value; const excludedId = excludedDigest.value; const missingId = missingDigest.value;
  const app = createApp({ db, credentials: { ingest: [], read: [{ ...tenant, token: "read" }],
    grade: [{ ...tenant, token: "grade", reviewer_id: "reviewer" }] } });
  await withTenant(db, tenant, async (trx) => {
    await sql`INSERT INTO observation.source_revision (producer, namespace, revision_id, run_id, unit_id,
      artifact_kind, artifact_schema_version, definition_id, body, body_digest, recorded_at)
      VALUES (${tenant.producer}, ${tenant.namespace}, 'rev-2', 'run-1', 'unit-1', 'brief', '1', 'definition-1',
        '{}'::jsonb, ${occurrence_id}, now())`.execute(trx);
    await sql`INSERT INTO observation.item_occurrence (producer, namespace, occurrence_id, revision_id, run_id,
      artifact_kind, schema_version, extractor_id, extractor_version, item_kind, item_selector, item_id_or_path, selected_value)
      VALUES (${tenant.producer}, ${tenant.namespace}, ${currentId}, 'rev-2', 'run-1', 'brief', '1',
        'fixture', '1', 'cohort_criterion', '/criterion', 'criterion-1', '{}'::jsonb),
        (${tenant.producer}, ${tenant.namespace}, ${excludedId}, 'rev-2', 'run-1', 'brief', '1',
        'fixture', '1', 'cohort_criterion', '/criterion', 'criterion-2', '{}'::jsonb),
        (${tenant.producer}, ${tenant.namespace}, ${missingId}, 'rev-2', 'run-1', 'brief', '1',
        'fixture', '1', 'cohort_criterion', '/criterion', 'criterion-3', '{}'::jsonb)`.execute(trx);
    for (const id of [occurrence_id, currentId]) await sql`INSERT INTO observation.evaluation_eligibility
      (producer, namespace, subject_occurrence_id, question_id, question_version, tag, payload)
      VALUES (${tenant.producer}, ${tenant.namespace}, ${id}, ${question.question_id}, ${question.question_version},
        'eligible', ${JSON.stringify({ evidence_set_id: evidence.evidence_set_id })}::jsonb)`.execute(trx);
    await sql`INSERT INTO observation.evaluation_eligibility
      (producer, namespace, subject_occurrence_id, question_id, question_version, tag, payload)
      VALUES (${tenant.producer}, ${tenant.namespace}, ${excludedId}, ${question.question_id},
        ${question.question_version}, 'skipped_budget', '{"kind":"skipped_budget","detail":"cap"}'::jsonb),
      (${tenant.producer}, ${tenant.namespace}, ${missingId}, ${question.question_id},
        ${question.question_version}, 'missing_evidence', '{"kind":"unevidenced"}'::jsonb)`.execute(trx);
  });
  const grade = await app.request("/v1/grades", { method: "POST",
    headers: { authorization: "Bearer grade", "content-type": "application/json" },
    body: JSON.stringify({ identity: { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
      question_id: question.question_id, question_version: question.question_version,
      evaluator_definition_id: "human", config_digest: "config-1", attempt_label: "old" },
      details: { answer: { state: "answered", kind: "boolean", value: true },
        origin: "human_rubric_answer" as const, collection_mode: "in_context", model_answers_visible: false, workflow_decisions_visible: false } }) });
  expect(grade.status).toBe(201);
  const graded = await grade.json() as { execution: { idempotency_digest: string } };
  const readbackPath = `/v1/evaluations/by-digest/${encodeURIComponent(graded.execution.idempotency_digest)}`;
  const readback = await app.request(readbackPath, { headers: { authorization: "Bearer read" } });
  expect(readback.status).toBe(200);
  expect((await readback.json()).observation).toBeTruthy();
  expect((await app.request(readbackPath, { headers: { authorization: "Bearer grade" } })).status).toBe(403);
  const selection = { run_id: "run-1", revision_id: null, question_id: question.question_id, question_version: question.question_version };
  const full = await readCoverage(db, tenant, selection);
  expect(full.questions[0]).toMatchObject({ eligible: 2, graded: 1, excluded: 2,
    exclusion_reasons: { skipped_budget: 1, missing_evidence: 1 },
    graded_by_collection_mode: { blind: 0, in_context: 1 } });
  expect(full.questions[0]?.excluded).toBe(Object.values(full.questions[0]!.exclusion_reasons).reduce((sum, count) => sum + count, 0));
  expect(full.query_version).toBe("human-coverage/v2");
  expect(full.questions[0]?.lag_seconds).toBeGreaterThanOrEqual(0);
  const current = await readCoverage(db, tenant, { ...selection, revision_id: "rev-2" });
  expect(current.questions[0]).toMatchObject({ eligible: 1, graded: 0, excluded: 2,
    graded_by_collection_mode: { blind: 0, in_context: 0 } });
  const response = await app.request(`/v1/runs/run-1/coverage?question_id=${question.question_id}&question_version=${question.question_version}&revision_id=rev-2`,
    { headers: { authorization: "Bearer read" } });
  expect(response.status).toBe(200);
  const body = await response.json() as CoverageProjection;
  expect(body.questions[0]!.graded).toBe(0);
  expect(body).not.toHaveProperty("truncated");
}));

integration("coverage includes every recorded question and every eligibility outcome", async () => scratchGrading(async (db, occurrence_id) => {
  const { registerQuestion } = await import("../src/storage/grading-store");
  const { recordEligibility } = await import("../src/storage/eligibility-store");
  const decisions: readonly import("../src/grading/eligibility").EligibilityDecision[] = [
    { tag: "eligible", payload: { evidence_set_id: evidence.evidence_set_id } },
    { tag: "inapplicable", payload: { reason: "unsupported provenance" } },
    { tag: "missing_evidence", payload: { kind: "unevidenced" } },
    { tag: "invalid_reference", payload: { kind: "unlinked" } },
    { tag: "blocked_dependency", payload: { dependency: "external-capture", detail: "pending" } },
    { tag: "skipped_budget", payload: { kind: "skipped_budget", detail: "cap" } },
  ];
  for (let index = 0; index < 51; index++) {
    const pin = { ...question, question_id: `coverage-question-${index}` as typeof question.question_id };
    expect((await registerQuestion(db, tenant, pin)).ok).toBe(true);
    expect((await recordEligibility(db, tenant, { ...tenant, subject_occurrence_id: occurrence_id,
      question_id: pin.question_id, question_version: pin.question_version, ...decisions[index % decisions.length]! })).ok).toBe(true);
  }
  const coverage = await readCoverage(db, tenant, { run_id: "run-1", revision_id: null, question_id: null, question_version: null });
  expect(coverage.questions).toHaveLength(51);
  expect(coverage).not.toHaveProperty("truncated");
  for (let index = 0; index < 51; index++) {
    const item = coverage.questions.find((item) => item.question_id === `coverage-question-${index}`)!;
    const decision = decisions[index % decisions.length]!;
    expect(item.eligible).toBe(decision.tag === "eligible" ? 1 : 0);
    expect(item.excluded).toBe(decision.tag === "eligible" ? 0 : 1);
    expect(item.excluded).toBe(Object.values(item.exclusion_reasons).reduce((sum, count) => sum + count, 0));
    if (decision.tag !== "eligible") expect(item.exclusion_reasons[decision.tag]).toBe(1);
  }
  expect((await readCoverage(db, tenant, { run_id: "other-run", revision_id: null, question_id: null, question_version: null })).questions)
    .toEqual([]);
}));
