import { sql } from "kysely";
import { expect, test } from "bun:test";
import { createApp } from "../src/http/app";
import { workOneJob } from "../src/grading/jobs/worker";
import { gradingLimits } from "../src/grading/jobs/budget";
import { registerGradingContext, registerQuestion, runGrade } from "../src/storage/grading-store";
import { withTenant } from "../src/storage/database";
import { enqueueJob } from "../src/storage/grading-job-store";
import type { GradeRunner } from "../src/ports/grade-runner";
import { tenant, question, evidence, evaluator, scratchGrading, capturedCoverage, captureProjectedFixture, pilotExpectations } from "./grading-fixture";
import { oakridgeQuestions } from "../src/grading/catalogue/oakridge-questions";
import { createJevDirectRunner } from "../src/runners/jev-direct";
import { instructionDigest } from "../src/grading/evaluator";
import type { JsonValue } from "../src/domain/primitives";
import type { QuestionDefinition } from "../src/grading/question";
import type { EvidenceSetId, ItemOccurrenceId, QuestionId } from "../src/domain/identity";
import { createLlmJudgeRunner } from "../src/runners/llm-judge";

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
const grade = { ...tenant, token: "grade-token" };
const read = { ...tenant, token: "read-token" };
const runner: GradeRunner = { kind: "model", async run() { return { ok: true,
  value: { answer: { state: "answered", kind: "boolean", value: true } } }; } };

integration("queued plan and brief model requests contain the captured criteria and cited sources", async () => scratchGrading(async (db) => {
  const plan_criterion = { id: "criterion", text: "Preserve captured source", task_ids: ["task"], decision_ids: ["decision"] };
  const task = { id: "task", description: "Capture the source", requirement_ids: [] };
  const decision = { id: "decision", text: "Keep immutable evidence" };
  const brief_criterion = { ...plan_criterion, text: "Retain the captured source unchanged" };
  await captureProjectedFixture(db, { revision_id: "model-tasks", artifact_kind: "tasks", body: { tasks: [task] } });
  const plan = await captureProjectedFixture(db, { revision_id: "model-plan", artifact_kind: "plan", body: {
    cohorts: [{ id: "cohort", decisions: [decision], acceptance_criteria: [plan_criterion] }], acceptance_criteria: [], risks: [],
  } });
  const brief = await captureProjectedFixture(db, { revision_id: "model-brief", artifact_kind: "brief", body: {
    cohort_id: "cohort", decisions_made: [], approaches_rejected: [], acceptance_criteria: [brief_criterion],
  } });
  const app = createApp({ db, credentials: { ingest: [], read: [read], grade: [grade] } });
  for (const [question_id, items, expected] of [
    ["plan.criterion_traceability", plan, { "plan_criterion:criterion": plan_criterion, "plan_task:task": task, "plan_decision:decision": decision }],
    ["brief.source_fidelity", brief, { "plan_criterion:criterion": plan_criterion, "brief_criterion:criterion": brief_criterion }],
  ] as const) {
    const question = oakridgeQuestions(pilotExpectations)[question_id].definition;
    const subject = items.find((item) => item.item_kind === "criterion")!;
    const criteria = Object.fromEntries(question.allowed_values!.map((value) => [String(value), String(value)]));
    const instruction_text = JSON.stringify({ system_one: { type: "choice", instructions: "Judge captured evidence", criteria } });
    const model = { ...evaluator("model"), evaluator_definition_id: question_id, model: "pinned-model", instruction_text,
      prompt_digest: instructionDigest(instruction_text) };
    const queued = await app.request("/v1/evaluation-jobs", { method: "POST",
      headers: { authorization: "Bearer grade-token", "content-type": "application/json" },
      body: JSON.stringify({ identity: { subject_occurrence_id: subject.occurrence_id,
        question_id, question_version: question.question_version, evaluator_definition_id: model.evaluator_definition_id,
        config_digest: model.config_digest, attempt_label: "captured-content" },
      context: { question, evaluator: model }, runner: "jev_direct", estimated_cost: 0.1 }) });
    expect({ status: queued.status, body: await queued.clone().text() }).toMatchObject({ status: 201 });
    const requests: JsonValue[] = [];
    const runner = createJevDirectRunner({ api_key: "key", base_url: "https://stub.invalid/v1", transport: async (_url, init) => {
      const request = JSON.parse(String(init.body)) as { readonly state: JsonValue };
      requests.push(request.state);
      const choice = String(question.allowed_values![0]);
      return Response.json({ model: "pinned-model", answers: { [question_id]: { type: "choice", choice,
        probabilities: Object.fromEntries(Object.keys(criteria).map((value) => [value, value === choice ? 1 : 0])), confidence: 1 } },
        usage: { input_tokens: 12, output_tokens: 3 } });
    } });
    expect((await workOneJob(db, tenant, gradingLimits(), "captured-model", runner)).kind).toBe("processed");
    expect(requests).toEqual([expected]);
    const job = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.grading_job").selectAll()
      .where("question_id", "=", question_id).executeTakeFirstOrThrow());
    expect(job).toMatchObject({ state: "terminal", terminal_cause: null });
  }
}));

interface JudgeEvidence { readonly ref: string; readonly content: JsonValue }
interface JudgeRequest { readonly messages: readonly { readonly content: string }[] }
interface JudgePrompt { readonly evidence: string }

interface JudgeScenario { readonly target: "report" | "code"; readonly requires_repository_snapshot: boolean }
const judge_scenarios: readonly JudgeScenario[] = [
  { target: "report", requires_repository_snapshot: false },
  { target: "code", requires_repository_snapshot: true },
  { target: "code", requires_repository_snapshot: false },
];
for (const { target, requires_repository_snapshot } of judge_scenarios) {
  integration(`a ${target} judge with snapshot flag ${requires_repository_snapshot} derives and grades captured evidence`, async () => scratchGrading(async (db) => {
    const original = { id: "criterion", text: "Preserve source", task_ids: [], decision_ids: [] };
    const revised = { ...original, text: "Keep source intact" };
    await captureProjectedFixture(db, { revision_id: "judge-plan", artifact_kind: "plan", body: {
      cohorts: [{ id: "cohort", decisions: [], acceptance_criteria: [original] }], acceptance_criteria: [], risks: [],
    } });
    const brief = await captureProjectedFixture(db, { revision_id: "judge-brief", artifact_kind: "brief", body: {
      cohort_id: "cohort", decisions_made: [], approaches_rejected: [], acceptance_criteria: [revised],
    } });
    const code = "export const captured = true;";
    const repository_address = "oakridge://revision/judge-source#/content";
    await captureProjectedFixture(db, { revision_id: "judge-source", artifact_kind: "repository_content",
      body: { head_sha: "reviewed-commit", content: code } });
    const finding = { criterion_id: "criterion", description: "Check source", evidence: [{ kind: "file", ref: repository_address }] };
    const assessment = await captureProjectedFixture(db, { revision_id: "judge-assessment", artifact_kind: "assessment",
      body: { head_sha: "reviewed-commit", verdict: "must stay hidden", findings: [finding] } });
    const subject = target === "report" ? brief.find((item) => item.item_kind === "criterion")!
      : assessment.find((item) => item.item_kind === "assessment_finding")!;
    const address = `oakridge://revision/${subject.revision_id}#${subject.json_pointer}`;
    const expected: readonly JudgeEvidence[] = target === "report" ? [
      { ref: "oakridge://revision/judge-plan#/cohorts/0/acceptance_criteria/0", content: original },
      { ref: address, content: revised },
    ] : [{ ref: address, content: finding }, { ref: repository_address, content: code }];
    const pinned: QuestionDefinition = { ...question, question_id: `judge-${target}` as QuestionId, question_version: "rubric-2026",
      target_item_kinds: [subject.item_kind], response_kind: "choice", allowed_values: ["faithful", "changed", "insufficient_evidence"],
      requires_repository_snapshot, input_recipe: { judge: { rubric: "Judge the captured target",
        evidence_refs: expected.map((ref) => ref.ref), max_evidence_chars: 5000, target } } };
    const model = { ...evaluator("model"), evaluator_definition_id: `judge-${target}`, provider: "fixture", model: "pinned-judge" };
    expect((await registerQuestion(db, tenant, pinned)).ok).toBe(true);
    const app = createApp({ db, credentials: { ingest: [], read: [read], grade: [grade] } });
    const eligibility = await app.request(`/v1/evaluation-eligibility?run_id=run-1&revision_id=${subject.revision_id}&question_id=${pinned.question_id}&question_version=${pinned.question_version}`,
      { headers: { authorization: "Bearer read-token" } });
    expect(eligibility.status).toBe(200);
    const decisions = await eligibility.json();
    expect(decisions.items).toMatchObject([{ subject_occurrence_id: subject.occurrence_id, question_version: "rubric-2026", tag: "eligible" }]);
    const evidence_set_id = decisions.items[0].payload.evidence_set_id as string;
    const identity = { subject_occurrence_id: subject.occurrence_id, question_id: pinned.question_id,
      question_version: pinned.question_version, evaluator_definition_id: model.evaluator_definition_id,
      config_digest: model.config_digest, attempt_label: "judge" };
    const request = { identity, context: { question: pinned, evaluator: model }, runner: "llm_judge",
      estimated_cost: 0.1, reviewed_commit: target === "code" ? "reviewed-commit" : undefined };
    const enqueue = (body: unknown) => app.request("/v1/evaluation-jobs", { method: "POST",
      headers: { authorization: "Bearer grade-token", "content-type": "application/json" }, body: JSON.stringify(body) });
    const mismatch = await enqueue({ ...request, identity: { ...identity, evidence_set_id: "caller-evidence" } });
    expect(mismatch.status).toBe(422);
    expect((await mismatch.json()).error.code).toBe("evidence_set_mismatch");
    if (target === "code") {
      for (const reviewed_commit of [undefined, "unrelated-commit"]) {
        const rejected = await enqueue({ ...request, reviewed_commit });
        expect(rejected.status).toBe(422);
        expect(await rejected.json()).toMatchObject({ error: { code: "job_refused",
          message: expect.stringContaining("repository evidence is not eligible for grading") } });
        let calls = 0;
        const blocked = await runGrade(db, tenant, {
          identity: { ...identity, subject_occurrence_id: subject.occurrence_id as ItemOccurrenceId,
            evidence_set_id: evidence_set_id as EvidenceSetId, attempt_label: `rejected-${reviewed_commit ?? "missing"}` },
          reviewed_commit, runner: { kind: "model", async run() {
            calls++;
            return { ok: false, error: { operation: "test", entity_id: "code", detail: "ineligible code reached the runner" } };
          } },
        });
        expect(blocked).toMatchObject({ ok: true, value: { execution: { status: "failed",
          error: "repository reference has no matching reviewed commit" }, observation: null } });
        expect(calls).toBe(0);
      }
      expect(await withTenant(db, tenant, (trx) => trx.selectFrom("observation.grading_job").select("job_id").execute())).toEqual([]);
    }
    const queued = await enqueue(request);
    expect({ status: queued.status, body: await queued.clone().text() }).toMatchObject({ status: 201 });
    const assigned = await app.request("/v1/blind-assignments", { method: "POST",
      headers: { authorization: "Bearer grade-token", "content-type": "application/json" }, body: JSON.stringify({
        subject_occurrence_id: subject.occurrence_id, question_id: pinned.question_id, question_version: pinned.question_version }) });
    expect(assigned.status).toBe(201);
    expect((await assigned.json()).evidence_set_id).toBe(evidence_set_id);
    const requests: (readonly JudgeEvidence[])[] = [];
    const runner = createLlmJudgeRunner({ api_key: "key", base_url: "https://stub.invalid/v1", transport: async (_url, init) => {
      const body = JSON.parse(String(init.body)) as JudgeRequest;
      const prompt = JSON.parse(body.messages[0]!.content) as JudgePrompt;
      requests.push(JSON.parse(prompt.evidence) as JudgeEvidence[]);
      expect(String(init.body)).not.toContain("must stay hidden");
      return Response.json({ id: "judge-completion", model: "pinned-judge", choices: [{ message: { content: JSON.stringify({
        choice: "faithful", probabilities: { faithful: 0.8, changed: 0.1, insufficient_evidence: 0.1 }, confidence: 0.8,
      }) } }] });
    } });
    expect((await workOneJob(db, tenant, gradingLimits(), "judge-worker", runner)).kind).toBe("processed");
    expect(requests).toEqual([expected]);
    const rows = await withTenant(db, tenant, async (trx) => ({
      jobs: await trx.selectFrom("observation.grading_job").select(["state", "terminal_cause", "evidence_set_id"]).execute(),
      grades: await trx.selectFrom("observation.grade_observation").select(["question_version", "evidence_set_id"]).execute(),
    }));
    expect(rows.jobs).toEqual([{ state: "terminal", terminal_cause: null, evidence_set_id }]);
    expect(rows.grades).toEqual([{ question_version: "rubric-2026", evidence_set_id }]);
  }));
}

integration("judge requests refuse evidence absent from the captured run without queuing work", async () => scratchGrading(async (db) => {
  const brief_body = { cohort_id: "cohort", decisions_made: [], approaches_rejected: [],
    acceptance_criteria: [{ id: "criterion", text: "Keep captured evidence" }] };
  const items = await captureProjectedFixture(db, { revision_id: "judge-local", artifact_kind: "brief", body: brief_body });
  await captureProjectedFixture(db, { revision_id: "judge-other-run", run_id: "other-run", artifact_kind: "brief", body: brief_body });
  const subject = items.find((item) => item.item_kind === "criterion")!;
  const app = createApp({ db, credentials: { ingest: [], read: [read], grade: [grade] } });
  for (const [name, address] of [["absent", "oakridge://revision/absent#/acceptance_criteria/0"],
    ["other-run", "oakridge://revision/judge-other-run#/acceptance_criteria/0"]]) {
    const pinned: QuestionDefinition = { ...question, question_id: `judge-missing-${name}` as QuestionId, question_version: "rubric-2",
      target_item_kinds: ["criterion"], response_kind: "choice", allowed_values: ["faithful", "insufficient_evidence"],
      input_recipe: { judge: { rubric: "Judge captured evidence", target: "report", max_evidence_chars: 1000,
        evidence_refs: [`oakridge://revision/judge-local#${subject.json_pointer}`, address!] } } };
    const response = await app.request("/v1/evaluation-jobs", { method: "POST",
      headers: { authorization: "Bearer grade-token", "content-type": "application/json" }, body: JSON.stringify({
        identity: { subject_occurrence_id: subject.occurrence_id as ItemOccurrenceId, question_id: pinned.question_id,
          question_version: pinned.question_version, evaluator_definition_id: "model", config_digest: "config-1", attempt_label: name },
        context: { question: pinned, evaluator: evaluator("model") }, runner: "llm_judge", estimated_cost: 0.1 }) });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "subject_ineligible", message: expect.stringContaining("missing_source") } });
  }
  expect(await withTenant(db, tenant, (trx) => trx.selectFrom("observation.grading_job").select("job_id").execute())).toEqual([]);
}));

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
