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
import { runPilot, type PilotRunPlan } from "../scripts/langfuse-pilot-run";
import { VERSION as CATALOGUE_VERSION } from "../src/projection/catalogue/oakridge-development";
import { DISAGREEMENT_POLICY_VERSION } from "../src/grading/coverage";
import type { Database } from "../src/storage/database";
import type { QuestionDefinition } from "../src/grading/question";

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
  const graded = await grade.json() as { execution: { idempotency_digest: string } };
  const readbackPath = `/v1/evaluations/by-digest/${encodeURIComponent(graded.execution.idempotency_digest)}`;
  const readback = await app.request(readbackPath, { headers: { authorization: "Bearer read" } });
  expect(readback.status).toBe(200);
  expect((await readback.json()).observation).toBeTruthy();
  expect((await app.request(readbackPath, { headers: { authorization: "Bearer grade" } })).status).toBe(403);
  const selection = { run_id: "run-1", revision_id: null, question_id: question.question_id, question_version: question.question_version };
  const full = await readCoverage(db, tenant, selection);
  expect(full.questions[0]).toMatchObject({ eligible: 2, graded: 1, excluded: 1,
    exclusion_reasons: { skipped_budget: 1 },
    graded_by_collection_mode: { blind: 0, in_context: 1, unknown: 0 } });
  expect(full.query_version).toBe("human-coverage/v2");
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
  expect(current.questions[0]).toMatchObject({ eligible: 1, graded: 0, excluded: 1,
    graded_by_collection_mode: { blind: 0, in_context: 0, unknown: 0 } });
  const response = await app.request(`/v1/runs/run-1/coverage?question_id=${question.question_id}&question_version=${question.question_version}&revision_id=rev-2`,
    { headers: { authorization: "Bearer read" } });
  expect(response.status).toBe(200);
  expect((await response.json()).questions[0].graded).toBe(0);
  const historical = canonicalDigest(["historical-human", occurrence_id]);
  if (!historical.ok) throw new Error(historical.error.detail);
  await withTenant(db, tenant, async (trx) => {
    await sql`INSERT INTO observation.evaluation_execution (producer, namespace, execution_id,
      subject_occurrence_id, evidence_set_id, question_id, question_version, evaluator_definition_id,
      config_digest, attempt_label, idempotency_digest, status, ended_at)
      VALUES (${tenant.producer}, ${tenant.namespace}, 'historical-human', ${occurrence_id},
        ${evidence.evidence_set_id}, ${question.question_id}, ${question.question_version},
        'human', 'config-1', 'historical', ${historical.value}, 'completed', now())`.execute(trx);
    await sql`INSERT INTO observation.grade_observation (producer, namespace, observation_id,
      execution_id, subject_occurrence_id, evidence_set_id, question_id, question_version,
      evaluator_definition_id, answer_kind, answer_state, answer_payload, reviewer_id)
      VALUES (${tenant.producer}, ${tenant.namespace}, 'historical-human', 'historical-human',
        ${occurrence_id}, ${evidence.evidence_set_id}, ${question.question_id}, ${question.question_version},
        'human', 'boolean', 'answered', '{"state":"answered","kind":"boolean","value":false}'::jsonb,
        'historical-reviewer')`.execute(trx);
  });
  const withHistorical = await readCoverage(db, tenant, selection);
  expect(withHistorical.questions[0]).toMatchObject({ graded: 1,
    graded_by_collection_mode: { blind: 0, in_context: 1, unknown: 1 } });
}));

integration("pilot manifest requires recorded eligibility before freezing selection", async () => scratchGrading(async (db, occurrence_id) => {
  const app = createApp({ db, credentials: { ingest: [], read: [{ ...tenant, token: "read" }],
    grade: [{ ...tenant, token: "grade", reviewer_id: "reviewer" }] } });
  const server = Bun.serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  try {
    const plan: PilotRunPlan = { tenant, population: { manifest_id: "pilot-eligibility",
      projection_version: "1", question_pins: [{ question_id: question.question_id,
        question_version: question.question_version }], selected: [{ occurrence_id,
        question_id: question.question_id, question_version: question.question_version,
        evidence, stratum: "clearly_easy", disposition: "included",
        reason: { kind: "operator", detail: "selected" } }] },
      attempts: [], human_grades: [], annotation_imports: [], examples: [] };
    const environment = { OBSERVATION_PILOT_BASE_URL: `http://127.0.0.1:${server.port}`,
      OBSERVATION_PILOT_GRADE_TOKEN: "grade", OBSERVATION_PILOT_READ_TOKEN: "read" };
    await expect(runPilot(plan, environment)).rejects.toThrow("recorded eligibility required");
    expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("human") })).ok).toBe(true);
    await withTenant(db, tenant, (trx) => sql`INSERT INTO observation.evaluation_eligibility
      (producer, namespace, subject_occurrence_id, question_id, question_version, tag, payload)
      VALUES (${tenant.producer}, ${tenant.namespace}, ${occurrence_id}, ${question.question_id},
        ${question.question_version}, 'eligible', ${JSON.stringify({ evidence_set_id: evidence.evidence_set_id })}::jsonb)`.execute(trx));
    await expect(runPilot(plan, environment)).rejects.toThrow("pilot requires 10 to 30 included item-level cases");
  } finally { server.stop(); }
}));

const choiceQuestion: QuestionDefinition = { ...question, question_id: "fidelity" as QuestionDefinition["question_id"],
  response_kind: "choice", allowed_values: ["altered", "preserved"] };

function fixtureId(label: string): string {
  const digest = canonicalDigest(["coverage", label]);
  if (!digest.ok) throw new Error(digest.error.detail);
  return digest.value;
}

async function addOccurrence(db: Database, label: string, tag: string = "eligible", version = CATALOGUE_VERSION): Promise<string> {
  const id = fixtureId(label);
  await withTenant(db, tenant, async (trx) => {
    await sql`INSERT INTO observation.item_occurrence (producer, namespace, occurrence_id, revision_id, run_id,
      artifact_kind, schema_version, extractor_id, extractor_version, item_kind, item_selector, item_id_or_path, selected_value)
      VALUES (${tenant.producer}, ${tenant.namespace}, ${id}, 'rev-1', 'run-1', 'brief', '1',
        'fixture', ${version}, 'cohort_criterion', '/criterion', ${label}, '{}'::jsonb)`.execute(trx);
    await sql`INSERT INTO observation.evaluation_eligibility
      (producer, namespace, subject_occurrence_id, question_id, question_version, tag, payload)
      VALUES (${tenant.producer}, ${tenant.namespace}, ${id}, ${choiceQuestion.question_id},
        ${choiceQuestion.question_version}, ${tag}, '{}'::jsonb)`.execute(trx);
  });
  return id;
}

async function addGrade(db: Database, label: string, occurrenceId: string, kind: "human" | "model" | "code",
  answer: { kind: string; state: string; value?: string | boolean; reason?: string }, evidenceId = evidence.evidence_set_id): Promise<void> {
  const digest = fixtureId(`execution-${label}`);
  await withTenant(db, tenant, async (trx) => {
    await sql`INSERT INTO observation.evaluation_execution (producer, namespace, execution_id,
      subject_occurrence_id, evidence_set_id, question_id, question_version, evaluator_definition_id,
      config_digest, attempt_label, idempotency_digest, status, ended_at)
      VALUES (${tenant.producer}, ${tenant.namespace}, ${label}, ${occurrenceId}, ${evidenceId},
        ${choiceQuestion.question_id}, ${choiceQuestion.question_version}, ${kind}, 'config-1', ${label},
        ${digest}, 'completed', now())`.execute(trx);
    await sql`INSERT INTO observation.grade_observation (producer, namespace, observation_id,
      execution_id, subject_occurrence_id, evidence_set_id, question_id, question_version,
      evaluator_definition_id, answer_kind, answer_state, answer_payload)
      VALUES (${tenant.producer}, ${tenant.namespace}, ${label}, ${label}, ${occurrenceId}, ${evidenceId},
        ${choiceQuestion.question_id}, ${choiceQuestion.question_version}, ${kind}, ${answer.kind},
        ${answer.state}, ${JSON.stringify(answer)}::jsonb)`.execute(trx);
  });
}

integration("coverage separates human, machine, pending, failed and excluded occurrences", async () => scratchGrading(async (db) => {
  for (const kind of ["human", "model", "code"] as const)
    expect((await registerGradingContext(db, tenant, { question: choiceQuestion, evidence, evaluator: evaluator(kind) })).ok).toBe(true);
  await withTenant(db, tenant, (trx) => sql`INSERT INTO observation.extractor_definition
    (producer, namespace, artifact_kind, schema_version, extractor_id, extractor_version, item_kind, item_selector)
    VALUES (${tenant.producer}, ${tenant.namespace}, 'brief', '1', 'fixture', '2', 'cohort_criterion', '/criterion')`.execute(trx));
  const human = await addOccurrence(db, "human");
  const machine = await addOccurrence(db, "machine", "eligible", "2");
  const pending = await addOccurrence(db, "pending");
  const failed = await addOccurrence(db, "failed");
  await addOccurrence(db, "inapplicable", "inapplicable");
  await addOccurrence(db, "missing", "missing_evidence");
  await addGrade(db, "human-grade", human, "human", { kind: "choice", state: "answered", value: "altered" });
  await addGrade(db, "machine-grade", machine, "model", { kind: "choice", state: "answered", value: "preserved" });
  await withTenant(db, tenant, async (trx) => {
    await sql`INSERT INTO observation.grading_job (producer, namespace, job_id, subject_occurrence_id,
      evidence_set_id, question_id, question_version, evaluator_definition_id, config_digest, attempt_label,
      idempotency_digest, runner_name, run_id, stage_id, state, retry_limit)
      VALUES (${tenant.producer}, ${tenant.namespace}, 'pending-job', ${pending}, ${evidence.evidence_set_id},
        ${choiceQuestion.question_id}, ${choiceQuestion.question_version}, 'model', 'config-1', 'pending',
        ${fixtureId("pending-job")}, 'fixture', 'run-1', 'stage', 'queued', 1)`.execute(trx);
    await sql`INSERT INTO observation.evaluation_execution (producer, namespace, execution_id,
      subject_occurrence_id, evidence_set_id, question_id, question_version, evaluator_definition_id,
      config_digest, attempt_label, idempotency_digest, status, error, ended_at)
      VALUES (${tenant.producer}, ${tenant.namespace}, 'failed-execution', ${failed}, ${evidence.evidence_set_id},
        ${choiceQuestion.question_id}, ${choiceQuestion.question_version}, 'model', 'config-1', 'failed',
        ${fixtureId("failed-execution")}, 'failed', 'runner error', now())`.execute(trx);
  });
  const projection = await readCoverage(db, tenant, { run_id: "run-1", revision_id: null,
    question_id: choiceQuestion.question_id, question_version: choiceQuestion.question_version });
  const row = projection.questions[0]!;
  expect(row.eligible).toBe(4);
  expect(row.human_label_graded).toBe(1);
  expect(row.graded).toBe(row.human_label_graded);
  expect(row.machine_graded).toBe(1);
  expect(row.pending).toBe(1);
  expect(row.failed).toBe(1);
  expect(row.disagreement).toBe(0);
  expect(row.exclusion_reasons).toEqual({ inapplicable: 1, missing_evidence: 1,
    invalid_reference: 0, blocked_dependency: 0, skipped_budget: 0 });
  expect(projection.selection_versions).toEqual([CATALOGUE_VERSION, "2"]);
  expect(projection.query_version).toBe("human-coverage/v2");
  expect(projection.disagreement_policy_version).toBe(DISAGREEMENT_POLICY_VERSION);
  const app = createApp({ db, credentials: { ingest: [], read: [{ ...tenant, token: "read" }], grade: [] } });
  const path = "/v1/runs/run-1/coverage";
  expect((await app.request(path)).status).toBe(403);
  expect((await app.request(`${path}?question_id=fidelity`, { headers: { authorization: "Bearer read" } })).status).toBe(400);
  expect((await app.request(`${path}?question_version=1`, { headers: { authorization: "Bearer read" } })).status).toBe(400);
  const response = await app.request(`${path}?revision_id=rev-1`, { headers: { authorization: "Bearer read" } });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.questions[0].graded).toBe(body.questions[0].human_label_graded);
  const forbidden = await app.request(path);
  expect((await forbidden.json()).error.code).toBe("forbidden");
  const invalid = await app.request(`${path}?question_id=fidelity`, { headers: { authorization: "Bearer read" } });
  expect((await invalid.json()).error.code).toBe("invalid_selection");
}));

integration("completed work is not pending and terminal failure counts once", async () => scratchGrading(async (db) => {
  expect((await registerGradingContext(db, tenant, { question: choiceQuestion, evidence, evaluator: evaluator("model") })).ok).toBe(true);
  const completed = await addOccurrence(db, "completed-job");
  const terminal = await addOccurrence(db, "terminal-job");
  await withTenant(db, tenant, async (trx) => {
    for (const [label, id, state, cause] of [["completed", completed, "queued", null],
      ["terminal", terminal, "terminal", "retry_exhausted"]] as const) {
      await sql`INSERT INTO observation.grading_job (producer, namespace, job_id, subject_occurrence_id,
        evidence_set_id, question_id, question_version, evaluator_definition_id, config_digest, attempt_label,
        idempotency_digest, runner_name, run_id, stage_id, state, terminal_cause, retry_limit)
        VALUES (${tenant.producer}, ${tenant.namespace}, ${label}, ${id}, ${evidence.evidence_set_id},
          ${choiceQuestion.question_id}, ${choiceQuestion.question_version}, 'model', 'config-1', ${label},
          ${fixtureId(`job-${label}`)}, 'fixture', 'run-1', 'stage', ${state}, ${cause}, 1)`.execute(trx);
    }
    await sql`INSERT INTO observation.evaluation_execution (producer, namespace, execution_id,
      subject_occurrence_id, evidence_set_id, question_id, question_version, evaluator_definition_id,
      config_digest, attempt_label, idempotency_digest, status, ended_at)
      VALUES (${tenant.producer}, ${tenant.namespace}, 'completed-execution', ${completed}, ${evidence.evidence_set_id},
        ${choiceQuestion.question_id}, ${choiceQuestion.question_version}, 'model', 'config-1', 'completed',
        ${fixtureId("completed-execution")}, 'completed', now())`.execute(trx);
    await sql`INSERT INTO observation.evaluation_execution (producer, namespace, execution_id,
      subject_occurrence_id, evidence_set_id, question_id, question_version, evaluator_definition_id,
      config_digest, attempt_label, idempotency_digest, status, error, ended_at)
      VALUES (${tenant.producer}, ${tenant.namespace}, 'terminal-execution', ${terminal}, ${evidence.evidence_set_id},
        ${choiceQuestion.question_id}, ${choiceQuestion.question_version}, 'model', 'config-1', 'terminal',
        ${fixtureId("terminal-execution")}, 'failed', 'runner error', now())`.execute(trx);
  });
  const row = (await readCoverage(db, tenant, { run_id: "run-1", revision_id: null,
    question_id: choiceQuestion.question_id, question_version: choiceQuestion.question_version })).questions[0]!;
  expect(row.pending).toBe(0);
  expect(row.failed).toBe(1);
}));

integration("disagreement compares latest substantive answers on the same evidence and answer kind", async () => scratchGrading(async (db) => {
  for (const kind of ["human", "model"] as const)
    expect((await registerGradingContext(db, tenant, { question: choiceQuestion, evidence, evaluator: evaluator(kind) })).ok).toBe(true);
  const otherEvidence = { ...evidence, evidence_set_id: "evidence-2" as typeof evidence.evidence_set_id };
  expect((await registerGradingContext(db, tenant, { question: choiceQuestion, evidence: otherEvidence, evaluator: evaluator("human") })).ok).toBe(true);
  const different = await addOccurrence(db, "disagree");
  const abstain = await addOccurrence(db, "abstain");
  const unclear = await addOccurrence(db, "unclear");
  const evidenceMismatch = await addOccurrence(db, "evidence-mismatch");
  const kindMismatch = await addOccurrence(db, "kind-mismatch");
  const rows = [
    ["different", different, { kind: "choice", state: "answered", value: "altered" }],
    ["abstain", abstain, { kind: "choice", state: "abstain", reason: "declined" }],
    ["unclear", unclear, { kind: "choice", state: "unclear", reason: "ambiguous" }],
    ["evidence", evidenceMismatch, { kind: "choice", state: "answered", value: "altered" }],
    ["kind", kindMismatch, { kind: "boolean", state: "answered", value: true }],
  ] as const;
  for (const [label, occurrence, answer] of rows) {
    await addGrade(db, `${label}-human`, occurrence, "human", answer);
    await addGrade(db, `${label}-model`, occurrence, "model",
      { kind: "choice", state: "answered", value: "preserved" },
      label === "evidence" ? otherEvidence.evidence_set_id : evidence.evidence_set_id);
  }
  const selection = { run_id: "run-1", revision_id: null, question_id: choiceQuestion.question_id,
    question_version: choiceQuestion.question_version };
  expect((await readCoverage(db, tenant, selection)).questions[0]?.disagreement).toBe(1);
  await addGrade(db, "different-human-correction", different, "human",
    { kind: "choice", state: "answered", value: "preserved" });
  expect((await readCoverage(db, tenant, selection)).questions[0]?.disagreement).toBe(0);
}));

integration("coverage caps question pins at fifty and reports truncation", async () => scratchGrading(async (db, occurrenceId) => {
  await withTenant(db, tenant, async (trx) => {
    for (let index = 0; index < 51; index++) {
      const id = `pin-${String(index).padStart(2, "0")}`;
      await sql`INSERT INTO observation.question_definition (producer, namespace, question_id, question_version,
        target_item_kinds, input_recipe, response_kind, missing_evidence_policy, abstain_semantics,
        unclear_semantics, interpretation_caveats, requires_repository_snapshot)
        VALUES (${tenant.producer}, ${tenant.namespace}, ${id}, '1', '["cohort_criterion"]'::jsonb,
          '{}'::jsonb, 'boolean', 'fail', 'none', 'none', 'none', false)`.execute(trx);
      await sql`INSERT INTO observation.evaluation_eligibility (producer, namespace, subject_occurrence_id,
        question_id, question_version, tag, payload)
        VALUES (${tenant.producer}, ${tenant.namespace}, ${occurrenceId}, ${id}, '1', 'eligible', '{}'::jsonb)`.execute(trx);
    }
  });
  const result = await readCoverage(db, tenant, { run_id: "run-1", revision_id: null,
    question_id: null, question_version: null });
  expect(result.questions).toHaveLength(50);
  expect(result.truncated).toBe(true);
  expect(result.questions[0]?.lag_seconds).toBeGreaterThanOrEqual(0);
}));
