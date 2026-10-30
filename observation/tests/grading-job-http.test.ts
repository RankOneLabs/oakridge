import { expect, test } from "bun:test";
import { createApp } from "../src/http/app";
import { workOneJob } from "../src/grading/jobs/worker";
import { gradingLimits } from "../src/grading/jobs/budget";
import { registerGradingContext, runGrade } from "../src/storage/grading-store";
import { withTenant } from "../src/storage/database";
import type { GradeRunner } from "../src/ports/grade-runner";
import { tenant, question, evidence, evaluator, scratchGrading } from "./grading-fixture";

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
const grade = { ...tenant, token: "grade-token" };
const read = { ...tenant, token: "read-token" };
const runner: GradeRunner = { kind: "model", async run() { return { ok: true,
  value: { answer: { state: "answered", kind: "boolean", value: true } } }; } };

integration("network runner requires the durable route and its pending job is readable", async () => scratchGrading(async (db, occurrence_id) => {
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
  const queued = await post("/v1/evaluation-jobs");
  expect(queued.status).toBe(201);
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
    body: JSON.stringify({ ...body, identity: { ...identity, attempt_label: "missing-credential" } }) });
  expect(unavailable.status).toBe(201);
  const pending = await unavailable.json();
  await workOneJob(db, tenant, gradingLimits(), "no-key", undefined, {});
  expect((await readAs("/v1/evaluation-jobs/" + pending.job_id)).status).toBe(200);
  expect((await readAs("/v1/items/" + encodeURIComponent(occurrence_id) + "/grades")).status).toBe(200);
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
