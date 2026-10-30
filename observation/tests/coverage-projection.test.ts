import { expect, test } from "bun:test";
import { sql } from "kysely";
import { createApp } from "../src/http/app";
import { withTenant } from "../src/storage/database";
import { readCoverage } from "../src/storage/coverage-store";
import { registerGradingContext } from "../src/storage/grading-store";
import { readEligibility } from "../src/storage/eligibility-store";
import { canonicalDigest } from "../src/canonical/canonical-json";
import { makePopulationManifestFromEligibility } from "../src/langfuse/population-manifest";
import { question, evidence, evaluator, scratchGrading, tenant } from "./grading-fixture";

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
integration("coverage uses recorded eligibility and keeps successive revisions separate", async () => scratchGrading(async (db, occurrence_id) => {
  expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("human") })).ok).toBe(true);
  const currentDigest = canonicalDigest(["current-occurrence"]);
  const excludedDigest = canonicalDigest(["excluded-occurrence"]);
  if (!currentDigest.ok || !excludedDigest.ok) throw new Error("fixture digest failed");
  const currentId = currentDigest.value; const excludedId = excludedDigest.value;
  const app = createApp({ db, credentials: { ingest: [], read: [{ ...tenant, token: "read" }],
    grade: [{ ...tenant, token: "grade", reviewer_id: "reviewer" }] } });
  await withTenant(db, tenant, async (trx) => {
    await sql`INSERT INTO observation.source_revision (producer, namespace, revision_id, run_id, unit_id,
      artifact_kind, artifact_schema_version, definition_bundle_id, definition_bundle_digest, body, body_digest, recorded_at)
      VALUES (${tenant.producer}, ${tenant.namespace}, 'rev-2', 'run-1', 'unit-1', 'brief', '1', 'bundle', 'digest',
        '{}'::jsonb, ${occurrence_id}, now())`.execute(trx);
    await sql`INSERT INTO observation.item_occurrence (producer, namespace, occurrence_id, revision_id, run_id,
      artifact_kind, schema_version, extractor_id, extractor_version, item_kind, item_selector, item_id_or_path, selected_value)
      VALUES (${tenant.producer}, ${tenant.namespace}, ${currentId}, 'rev-2', 'run-1', 'brief', '1',
        'fixture', '1', 'cohort_criterion', '/criterion', 'criterion-1', '{}'::jsonb),
        (${tenant.producer}, ${tenant.namespace}, ${excludedId}, 'rev-2', 'run-1', 'brief', '1',
        'fixture', '1', 'cohort_criterion', '/criterion', 'criterion-2', '{}'::jsonb)`.execute(trx);
    for (const id of [occurrence_id, currentId]) await sql`INSERT INTO observation.evaluation_eligibility
      (producer, namespace, subject_occurrence_id, question_id, question_version, tag, payload)
      VALUES (${tenant.producer}, ${tenant.namespace}, ${id}, ${question.question_id}, ${question.question_version},
        'eligible', ${JSON.stringify({ evidence_set_id: evidence.evidence_set_id })}::jsonb)`.execute(trx);
    await sql`INSERT INTO observation.evaluation_eligibility
      (producer, namespace, subject_occurrence_id, question_id, question_version, tag, payload)
      VALUES (${tenant.producer}, ${tenant.namespace}, ${excludedId}, ${question.question_id},
        ${question.question_version}, 'skipped_budget', '{"kind":"skipped_budget","detail":"cap"}'::jsonb)`.execute(trx);
  });
  const grade = await app.request("/v1/grades", { method: "POST",
    headers: { authorization: "Bearer grade", "content-type": "application/json" },
    body: JSON.stringify({ identity: { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
      question_id: question.question_id, question_version: question.question_version,
      evaluator_definition_id: "human", config_digest: "config-1", attempt_label: "old" },
      details: { answer: { state: "answered", kind: "boolean", value: true },
        collection_mode: "in_context", model_answers_visible: false, workflow_decisions_visible: false } }) });
  expect(grade.status).toBe(201);
  const selection = { run_id: "run-1", revision_id: null, question_id: question.question_id, question_version: question.question_version };
  const full = await readCoverage(db, tenant, selection);
  expect(full.questions[0]).toMatchObject({ eligible: 2, graded: 1, excluded: 1,
    exclusion_reasons: { skipped_budget: 1 } });
  expect(full.query_version).toBe("human-coverage/v1");
  expect(full.questions[0]?.lag_seconds).toBeGreaterThanOrEqual(0);
  const eligibility = await readEligibility(db, tenant, question.question_id, question.question_version);
  const manifest = makePopulationManifestFromEligibility({ manifest_id: "coverage-fixture", projection_version: "1",
    question_pins: [{ question_id: question.question_id, question_version: question.question_version }],
    selected: eligibility.map((row) => ({ occurrence_id: row.subject_occurrence_id, question_id: row.question_id,
      question_version: row.question_version, evidence, stratum: "clearly_easy" as const,
      disposition: "included" as const, reason: { kind: "operator" as const, detail: "candidate" } })) }, eligibility);
  expect(manifest.ok).toBe(true);
  if (!manifest.ok) throw new Error(manifest.error.detail);
  expect(full.questions[0]?.eligible).toBe(manifest.value.membership.filter((member) => member.disposition === "included").length);
  const current = await readCoverage(db, tenant, { ...selection, revision_id: "rev-2" });
  expect(current.questions[0]).toMatchObject({ eligible: 1, graded: 0, excluded: 1 });
  const response = await app.request(`/v1/runs/run-1/coverage?question_id=${question.question_id}&question_version=${question.question_version}&revision_id=rev-2`,
    { headers: { authorization: "Bearer read" } });
  expect(response.status).toBe(200);
  expect((await response.json()).questions[0].graded).toBe(0);
}));
