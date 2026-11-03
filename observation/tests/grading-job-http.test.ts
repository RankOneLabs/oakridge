import { sql } from "kysely";
import { expect, test } from "bun:test";
import { createApp } from "../src/http/app";
import { workOneJob } from "../src/grading/jobs/worker";
import { gradingLimits } from "../src/grading/jobs/budget";
import { registerGradingContext, runGrade } from "../src/storage/grading-store";
import { withTenant } from "../src/storage/database";
import { enqueueJob } from "../src/storage/grading-job-store";
import type { GradeRunner } from "../src/ports/grade-runner";
import { tenant, question, evidence, evaluator, scratchGrading, capturedCoverage } from "./grading-fixture";

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
const grade = { ...tenant, token: "grade-token" };
const read = { ...tenant, token: "read-token" };
const runner: GradeRunner = { kind: "model", async run() { return { ok: true,
  value: { answer: { state: "answered", kind: "boolean", value: true } } }; } };

integration("network runner requires the durable route and its pending job is readable", async () => scratchGrading(async (db) => {
  const { occurrence_id, question, evidence } = await capturedCoverage(db);
  const app = createApp({ db, credentials: { ingest: [], read: [read], grade: [grade] },
    gradingLimits: gradingLimits({ OBSERVATION_GRADING_RETRY_LIMIT: "7" }) });
  const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
    question_id: question.question_id, question_version: question.question_version,
    evaluator_definition_id: "model", config_digest: "config-1", attempt_label: "http" };
  const body = { identity, context: { question, evidence, evaluator: evaluator("model") },
    runner: "jev_direct", estimated_cost: 0.2 };
  const post = (path: string) => app.request(path, { method: "POST",
    headers: { authorization: "Bearer grade-token", "content-type": "application/json" },
    body: JSON.stringify(body) });
  const synchronous = await post("/v1/evaluations");
  expect(synchronous.status).toBe(422);
  expect(await synchronous.json()).toMatchObject({ error: { code: "queued_evaluation_required" } });
  const { evidence_set_id: _supplied, ...derivedIdentity } = identity;
  const queuedBody = { ...body, identity: derivedIdentity, context: { question, evaluator: evaluator("model") } };
  const queued = await app.request("/v1/evaluation-jobs", { method: "POST",
    headers: { authorization: "Bearer grade-token", "content-type": "application/json" }, body: JSON.stringify(queuedBody) });
  expect({ status: queued.status, body: await queued.clone().text() }).toMatchObject({ status: 201 });
  const result = await queued.json();
  expect(result.state).toBe("queued");
  const readAs = (path: string) => app.request(path, { headers: { authorization: "Bearer read-token" } });
  expect((await readAs("/v1/evaluation-jobs/" + result.job_id)).status).toBe(200);
  expect((await (await readAs("/v1/evaluation-jobs/" + result.job_id)).json()).retry_limit).toBe(7);
  expect((await readAs("/v1/items/" + encodeURIComponent(occurrence_id) + "/evaluation-jobs")).status).toBe(200);
  await workOneJob(db, tenant, gradingLimits(), "http-worker", runner);
  const job = await (await readAs("/v1/evaluation-jobs/" + result.job_id)).json();
  expect(job.state).toBe("terminal");
  const grades = await (await readAs("/v1/items/" + encodeURIComponent(occurrence_id) + "/grades")).json();
  expect((await readAs("/v1/evaluation-executions/" + grades.items[0].execution.execution_id)).status).toBe(200);
  const unavailable = await app.request("/v1/evaluation-jobs", { method: "POST",
    headers: { authorization: "Bearer grade-token", "content-type": "application/json" },
    body: JSON.stringify({ ...queuedBody, identity: { ...derivedIdentity, attempt_label: "missing-credential" } }) });
  expect(unavailable.status).toBe(201);
  const pending = await unavailable.json();
  await workOneJob(db, tenant, gradingLimits(), "no-key", undefined, {});
  expect((await readAs("/v1/evaluation-jobs/" + pending.job_id)).status).toBe(200);
  expect((await readAs("/v1/items/" + encodeURIComponent(occurrence_id) + "/grades")).status).toBe(200);
}));

integration("enqueue checks supplied and stored identity, evaluator kind and evidence", async () => scratchGrading(async (db, occurrence_id) => {
  const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
    question_id: question.question_id, question_version: question.question_version,
    evaluator_definition_id: "model", config_digest: "config-1", attempt_label: "direct" };
  const context = { question, evidence, evaluator: evaluator("model") };
  const limits = gradingLimits();
  await expect(enqueueJob(db, tenant, { identity, context, runner_name: "deterministic" }, limits))
    .rejects.toThrow("runner kind differs");
  await expect(enqueueJob(db, tenant, { identity: { ...identity, question_id: "missing" as typeof question.question_id },
    runner_name: "stub_model" }, limits)).rejects.toThrow("question definition does not exist");
  const incomplete = { ...evidence, evidence_set_id: "incomplete-evidence" as typeof evidence.evidence_set_id,
    is_incomplete: true, incompleteness_reason: "missing pinned source" };
  await expect(enqueueJob(db, tenant, { identity: { ...identity, evidence_set_id: incomplete.evidence_set_id },
    context: { question, evidence: incomplete, evaluator: evaluator("model") }, runner_name: "stub_model" }, limits))
    .rejects.toThrow("missing pinned source");
  const app = createApp({ db, credentials: { ingest: [], read: [read], grade: [grade] } });
  const bad = await app.request("/v1/evaluation-jobs", { method: "POST",
    headers: { authorization: "Bearer grade-token", "content-type": "application/json" },
    body: JSON.stringify({ identity: { ...identity, attempt_label: "http-bad" }, context,
      runner: "deterministic" }) });
  expect(bad.status).toBe(400);
  expect((await withTenant(db, tenant, (trx) => trx.selectFrom("observation.grading_job")
    .select("job_id").execute()))).toHaveLength(0);
}));

integration("grade operator fences an abandoned manual execution and retries with a new attempt", async () => scratchGrading(async (db, occurrence_id) => {
  expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("model") })).ok).toBe(true);
  const app = createApp({ db, credentials: { ingest: [], read: [read], grade: [grade] } });
  const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
    question_id: question.question_id, question_version: question.question_version,
    evaluator_definition_id: "model", config_digest: "config-1", attempt_label: "abandoned" };
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const held: GradeRunner = { kind: "model", async run() { entered(); await waiting; return runner.run({} as never); } };
  const pending = runGrade(db, tenant, { identity, runner: held });
  await started;
  const contended = await runGrade(db, tenant, { identity, runner });
  expect(contended.ok ? null : contended.error.outcome).toBe("in_progress");
  const execution = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluation_execution")
    .selectAll().executeTakeFirstOrThrow());
  const path = `/v1/evaluation-executions/${execution.execution_id}/recover`;
  expect((await app.request(path, { method: "POST", headers: { authorization: "Bearer read-token" } })).status).toBe(403);
  const recovered = await app.request(path, { method: "POST", headers: { authorization: "Bearer grade-token" } });
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toMatchObject({ execution_id: execution.execution_id, status: "failed" });
  release();
  expect((await pending).ok).toBe(false);
  expect((await runGrade(db, tenant, { identity: { ...identity, attempt_label: "recovered" },
    runner })).ok).toBe(true);
  const rows = await withTenant(db, tenant, async (trx) => ({
    executions: await trx.selectFrom("observation.evaluation_execution").selectAll().execute(),
    grades: await trx.selectFrom("observation.grade_observation").selectAll().execute(),
  }));
  expect(rows.executions.map((row) => row.status).sort()).toEqual(["completed", "failed"]);
  expect(rows.executions.find((row) => row.execution_id === execution.execution_id)?.error).toBe("operator_recovery");
  expect(rows.grades).toHaveLength(1);
}));

for (const recorded of [
  { definition_id: "old-definition", artifact_schema_version: "1", field: "definition_id" },
  { definition_id: "definition-1", artifact_schema_version: "old-schema", field: "artifact_schema_version" },
  { definition_id: null, artifact_schema_version: "1", field: "definition_id" },
  { definition_id: "definition-1", artifact_schema_version: null, field: "artifact_schema_version" },
]) {
  integration(`all four routes refuse unsupported ${recorded.field}=${recorded[recorded.field as "definition_id" | "artifact_schema_version"]} without grading rows`,
    async () => scratchGrading(async (db, occurrence_id) => {
      // Emulate a pre-identity capture in this disposable database only.
      await sql`ALTER TABLE observation.source_revision ALTER COLUMN definition_id DROP NOT NULL,
        ALTER COLUMN artifact_schema_version DROP NOT NULL`.execute(db);
      await withTenant(db, tenant, (trx) => sql`UPDATE observation.source_revision
        SET definition_id = ${recorded.definition_id}, artifact_schema_version = ${recorded.artifact_schema_version},
          body = '{"legacy":"no decoder should inspect this"}'::jsonb
        WHERE producer = ${tenant.producer} AND namespace = ${tenant.namespace}`.execute(trx));
      expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("code") })).ok).toBe(true);
      // Even a previously recorded eligible decision cannot bypass the provenance gate.
      await withTenant(db, tenant, (trx) => sql`INSERT INTO observation.evaluation_eligibility
        (producer, namespace, subject_occurrence_id, question_id, question_version, tag, payload)
        VALUES (${tenant.producer}, ${tenant.namespace}, ${occurrence_id}, ${question.question_id}, ${question.question_version},
          'eligible', ${JSON.stringify({ evidence_set_id: evidence.evidence_set_id })}::jsonb)`.execute(trx));
      const app = createApp({ db, credentials: { ingest: [], read: [read], grade: [grade] } });
      const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
        question_id: question.question_id, question_version: question.question_version,
        evaluator_definition_id: "code", config_digest: "config-1", attempt_label: "unsupported" };
      const counts = () => withTenant(db, tenant, async (trx) => ({
        jobs: await trx.selectFrom("observation.grading_job").select("job_id").execute(),
        assignments: await trx.selectFrom("observation.blind_assignment").select("assignment_id").execute(),
        executions: await trx.selectFrom("observation.evaluation_execution").select("execution_id").execute(),
      }));
      const before = await counts();
      const eligibility = await app.request(`/v1/evaluation-eligibility?run_id=run-1&question_id=${question.question_id}&question_version=${question.question_version}`,
        { headers: { authorization: "Bearer read-token" } });
      expect(eligibility.status).toBe(200);
      const decision = (await eligibility.json()).items[0];
      expect(decision).toMatchObject({ subject_occurrence_id: occurrence_id, tag: "inapplicable" });
      expect(decision.payload.reason).toContain(`${recorded.field}: recorded=${JSON.stringify(recorded[recorded.field as "definition_id" | "artifact_schema_version"])}`);
      expect(decision.payload.reason).toContain(`pinned=${JSON.stringify(question.pinned_expectation[recorded.field as "definition_id" | "artifact_schema_version"])}`);
      expect(await counts()).toEqual(before);
      for (const path of ["/v1/evaluation-jobs", "/v1/blind-assignments", "/v1/evaluations"]) {
        const response = await app.request(path, { method: "POST",
          headers: { authorization: "Bearer grade-token", "content-type": "application/json" },
          body: JSON.stringify(path === "/v1/blind-assignments" ? identity
            : { identity, runner: "deterministic" }) });
        expect(response.status).toBe(path === "/v1/blind-assignments" ? 409 : 422);
        expect((await response.json()).error.message).toContain("Unsupported provenance");
        expect(await counts()).toEqual(before);
      }
      await expect(enqueueJob(db, tenant, { identity, runner_name: "deterministic" }, gradingLimits()))
        .rejects.toThrow("Unsupported provenance");
      expect(await counts()).toEqual(before);
    }));
}

integration("enqueue and assignment derive evidence and refuse a disagreeing caller id without creating work", async () => scratchGrading(async (db) => {
  const { occurrence_id, question, evidence } = await capturedCoverage(db);
  const app = createApp({ db, credentials: { ingest: [], read: [read], grade: [grade] } });
  const identity = { subject_occurrence_id: occurrence_id, question_id: question.question_id,
    question_version: question.question_version };
  const post = (path: string, body: unknown) => app.request(path, { method: "POST",
    headers: { authorization: "Bearer grade-token", "content-type": "application/json" }, body: JSON.stringify(body) });
  const jobBody = { identity: { ...identity, evaluator_definition_id: "model", config_digest: "config-1", attempt_label: "derived" },
    context: { question, evaluator: evaluator("model") }, runner: "stub_model" };
  const badJob = await post("/v1/evaluation-jobs", { ...jobBody,
    identity: { ...jobBody.identity, evidence_set_id: "caller-named-evidence" } });
  expect(badJob.status).toBe(422);
  expect((await badJob.json()).error.code).toBe("evidence_set_mismatch");
  const badAssignment = await post("/v1/blind-assignments", { ...identity, evidence_set_id: "caller-named-evidence" });
  expect(badAssignment.status).toBe(409);
  expect((await badAssignment.json()).error.code).toBe("evidence_set_mismatch");
  expect(await withTenant(db, tenant, async (trx) => ({
    jobs: await trx.selectFrom("observation.grading_job").select("job_id").execute(),
    assignments: await trx.selectFrom("observation.blind_assignment").select("assignment_id").execute(),
  }))).toEqual({ jobs: [], assignments: [] });
  const job = await post("/v1/evaluation-jobs", jobBody);
  expect(job.status).toBe(201);
  const assignment = await post("/v1/blind-assignments", identity);
  expect(assignment.status).toBe(201);
  expect((await assignment.json()).evidence_set_id).toBe(evidence.evidence_set_id);
  const { captureProjectedFixture } = await import("./grading-fixture");
  await captureProjectedFixture(db, { revision_id: "assessment-newer", artifact_kind: "assessment",
    body: { findings: [{ criterion_id: "criterion", evidence: [], description: "new evidence" }] },
    recorded_at: "2026-11-01T02:00:00Z" });
  const pinned = await post("/v1/evaluation-jobs", { ...jobBody,
    identity: { ...jobBody.identity, attempt_label: "still-pinned" } });
  expect(pinned.status).toBe(201);
  const stored = await withTenant(db, tenant, async (trx) => ({
    jobs: await trx.selectFrom("observation.grading_job").select("evidence_set_id").execute(),
    assignments: await trx.selectFrom("observation.blind_assignment").select("evidence_set_id").execute(),
    evidence: await trx.selectFrom("observation.evidence_set").selectAll()
      .where("evidence_set_id", "=", evidence.evidence_set_id).executeTakeFirstOrThrow(),
  }));
  expect(stored.jobs.map((row) => row.evidence_set_id)).toEqual([evidence.evidence_set_id, evidence.evidence_set_id]);
  expect(stored.assignments.map((row) => row.evidence_set_id)).toEqual([evidence.evidence_set_id]);
  expect(stored.evidence.evidence_refs).toEqual(evidence.references);
}));
