import { expect, test } from "bun:test";
import { sql } from "kysely";
import { occurrenceId } from "../src/projection/occurrence-id";
import { withTenant } from "../src/storage/database";
import { enqueueJob, claimJob } from "../src/storage/grading-job-store";
import { gradingLimits } from "../src/grading/jobs/budget";
import { readEligibility, recordEligibility } from "../src/storage/eligibility-store";
import { registerGradingContext } from "../src/storage/grading-store";
import { workOneJob } from "../src/grading/jobs/worker";
import type { GradeRunner } from "../src/ports/grade-runner";
import { tenant, question, evidence, evaluator, scratchGrading } from "./grading-fixture";
const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
test("grading limits retain zero and reject invalid named settings", () => {
  expect(gradingLimits({ OBSERVATION_GRADING_RUN_SPEND: "0", OBSERVATION_GRADING_STAGE_SPEND: "0",
    OBSERVATION_GRADING_RUN_CONCURRENCY: "0", OBSERVATION_GRADING_RETRY_LIMIT: "0",
    OBSERVATION_GRADING_LEASE_MS: "0", OBSERVATION_PROVIDER_DEADLINE_MS: "0" })).toMatchObject({
    run_spend: 0, stage_spend: 0, run_concurrency: 0, retry_limit: 0, lease_ms: 0, provider_deadline_ms: 0 });
  for (const name of ["OBSERVATION_GRADING_RETRY_LIMIT", "OBSERVATION_GRADING_RUN_CONCURRENCY",
    "OBSERVATION_GRADING_STAGE_CONCURRENCY"] as const) {
    for (const value of ["-1", "2.7", "NaN", "Infinity"]) {
      expect(() => gradingLimits({ [name]: value })).toThrow(name);
    }
  }
});

integration("a blocked oldest stage does not starve another stage or run", async () => scratchGrading(async (db, occurrence_id) => {
  expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("model") })).ok).toBe(true);
  const limits = { ...gradingLimits(), run_concurrency: 2, stage_concurrency: 1, run_spend: 10, stage_spend: 10 };
  const makeOccurrence = (revision_id: string, item_id_or_path: string) => {
    const result = occurrenceId({ ...tenant, revision_id, extractor_id: "fixture", extractor_version: "1",
      item_selector: "/criterion", item_id_or_path });
    if (!result.ok) throw new Error(result.error.detail);
    return result.value;
  };
  const secondOccurrence = makeOccurrence("rev-2", "criterion-2");
  const thirdOccurrence = makeOccurrence("rev-3", "criterion-3");
  await withTenant(db, tenant, async (trx) => {
    for (const [revision, run, stage, occurrence, path] of [["rev-2", "run-1", "unit-2", secondOccurrence, "criterion-2"],
      ["rev-3", "run-2", "unit-3", thirdOccurrence, "criterion-3"]]) {
      await sql`INSERT INTO observation.source_revision
        (producer, namespace, revision_id, run_id, unit_id, artifact_kind, artifact_schema_version,
         definition_bundle_id, definition_bundle_digest, body, body_digest, recorded_at)
        SELECT producer, namespace, ${revision}, ${run}, ${stage}, artifact_kind, artifact_schema_version,
          definition_bundle_id, definition_bundle_digest, body, body_digest, recorded_at
        FROM observation.source_revision WHERE revision_id = 'rev-1'`.execute(trx);
      await sql`INSERT INTO observation.item_occurrence
        (producer, namespace, occurrence_id, revision_id, run_id, artifact_kind, schema_version,
         extractor_id, extractor_version, item_kind, item_selector, item_id_or_path, selected_value)
        SELECT producer, namespace, ${occurrence}, ${revision}, ${run}, artifact_kind, schema_version,
          extractor_id, extractor_version, item_kind, item_selector, ${path}, selected_value
        FROM observation.item_occurrence WHERE occurrence_id = ${occurrence_id}`.execute(trx);
    }
  });
  const identity = (subject_occurrence_id: string, attempt_label: string) => ({
    subject_occurrence_id: subject_occurrence_id as typeof occurrence_id, evidence_set_id: evidence.evidence_set_id,
    question_id: question.question_id, question_version: question.question_version,
    evaluator_definition_id: "model", config_digest: "config-1", attempt_label });
  const first = await enqueueJob(db, tenant, { identity: identity(occurrence_id, "first"), runner_name: "stub_model" }, limits);
  expect((await claimJob(db, tenant, "owner-1", limits)).kind).toBe("admitted");
  const blocked = await enqueueJob(db, tenant, { identity: identity(occurrence_id, "blocked"), runner_name: "stub_model" }, limits);
  const stage = await enqueueJob(db, tenant, { identity: identity(secondOccurrence, "stage"), runner_name: "stub_model" }, limits);
  const run = await enqueueJob(db, tenant, { identity: identity(thirdOccurrence, "run"), runner_name: "stub_model" }, limits);
  const firstClaims = await Promise.all([
    claimJob(db, tenant, "owner-2", limits), claimJob(db, tenant, "owner-3", limits),
  ]);
  const admitted = firstClaims.filter((result) => result.kind === "admitted").map((result) => result.job.job_id);
  if (admitted.length < 2) {
    const another = await claimJob(db, tenant, "owner-5", limits);
    if (another.kind === "admitted") admitted.push(another.job.job_id);
  }
  expect(admitted.sort()).toEqual([stage.job_id, run.job_id].sort());
  await withTenant(db, tenant, (trx) => trx.updateTable("observation.grading_job")
    .set({ state: "terminal", lease_owner: null, lease_expires_at: null })
    .where("job_id", "in", [first.job_id, stage.job_id]).execute());
  const fourth = await claimJob(db, tenant, "owner-4", limits);
  expect(fourth.kind === "admitted" && fourth.job.job_id).toBe(blocked.job_id);
}));

integration("an unsent preflight failure records zero charge and no retry", async () => scratchGrading(async (db, occurrence_id) => {
  expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("model") })).ok).toBe(true);
  const limits = { ...gradingLimits(), run_spend: 0.2, stage_spend: 0.2 };
  const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
    question_id: question.question_id, question_version: question.question_version,
    evaluator_definition_id: "model", config_digest: "config-1", attempt_label: "preflight" };
  const job = await enqueueJob(db, tenant, { identity, runner_name: "llm_judge", estimated_cost: 0.2 }, limits);
  await workOneJob(db, tenant, limits, "preflight-worker", undefined,
    { OBSERVATION_LLM_JUDGE_API_KEY: "" });
  const result = await withTenant(db, tenant, async (trx) => ({
    job: await trx.selectFrom("observation.grading_job").selectAll().where("job_id", "=", job.job_id).executeTakeFirstOrThrow(),
    attempts: await trx.selectFrom("observation.grading_provider_attempt").selectAll().execute(),
  }));
  expect(result.job.state).toBe("terminal");
  expect(result.attempts).toMatchObject([{ request_sent: false, charged_cost: 0,
    failure_category: "unconfigured_credential" }]);
  const next = await enqueueJob(db, tenant, { identity: { ...identity, attempt_label: "after-preflight" },
    runner_name: "llm_judge", estimated_cost: 0.2 }, limits);
  const claimed = await claimJob(db, tenant, "next-worker", limits);
  expect(claimed.kind === "admitted" && claimed.job.job_id).toBe(next.job_id);
}));

integration("invalid question, recipe and evidence bound fail before any provider request", async () => scratchGrading(async (db, occurrence_id) => {
  const limits = { ...gradingLimits(), run_spend: 1, stage_spend: 1 };
  const choice = { ...question, response_kind: "choice" as const,
    allowed_values: ["yes", "insufficient_evidence"] };
  const cases = [
    { label: "question-shape", definition: question },
    { label: "recipe", definition: { ...choice, question_id: "bad-recipe" as typeof question.question_id,
      input_recipe: {} } },
    { label: "evidence-bound", definition: { ...choice, question_id: "oversized" as typeof question.question_id,
      input_recipe: { judge: { rubric: "grade", evidence_refs: ["fixture"], max_evidence_chars: 1, target: "report" } } } },
  ];
  for (const item of cases) {
    expect((await registerGradingContext(db, tenant, { question: item.definition, evidence,
      evaluator: evaluator("model") })).ok).toBe(true);
    const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
      question_id: item.definition.question_id, question_version: item.definition.question_version,
      evaluator_definition_id: "model", config_digest: "config-1", attempt_label: item.label };
    const job = await enqueueJob(db, tenant, { identity, runner_name: "llm_judge", estimated_cost: 0.2 }, limits);
    await workOneJob(db, tenant, limits, `${item.label}-worker`, undefined,
      { OBSERVATION_LLM_JUDGE_API_KEY: "test-key" });
    const attempt = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.grading_provider_attempt")
      .selectAll().where("job_id", "=", job.job_id).executeTakeFirstOrThrow());
    expect(attempt).toMatchObject({ request_sent: false, charged_cost: 0, outcome: "failed",
      failure_category: "invalid_request" });
  }
}));

integration("a live second attempt excludes only its own charge", async () => scratchGrading(async (db, occurrence_id) => {
  expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("model") })).ok).toBe(true);
  const limits = { ...gradingLimits(), run_spend: 0.5, stage_spend: 0.5,
    run_concurrency: 2, stage_concurrency: 2 };
  const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
    question_id: question.question_id, question_version: question.question_version,
    evaluator_definition_id: "model", config_digest: "config-1", attempt_label: "interrupted" };
  const job = await enqueueJob(db, tenant, { identity, runner_name: "llm_judge", estimated_cost: 0.2 }, limits);
  expect((await claimJob(db, tenant, "first", limits)).kind).toBe("admitted");
  await withTenant(db, tenant, async (trx) => {
    await trx.insertInto("observation.grading_provider_attempt").values({ ...tenant,
      job_id: job.job_id, attempt: 1, run_id: job.run_id, stage_id: job.stage_id,
      request_sent: true, outcome: null, charged_cost: 0.2, admitted_estimate: 0.2,
      cost_overage: 0, provider_request_id: null, failure_category: null }).execute();
    await trx.updateTable("observation.grading_job")
      .set({ lease_expires_at: new Date(Date.now() - 1) }).where("job_id", "=", job.job_id).execute();
  });
  const second = await claimJob(db, tenant, "second", limits);
  expect(second.kind === "admitted" && second.job.attempts).toBe(2);
  await withTenant(db, tenant, (trx) => trx.insertInto("observation.grading_provider_attempt").values({ ...tenant,
    job_id: job.job_id, attempt: 2, run_id: job.run_id, stage_id: job.stage_id,
    request_sent: true, outcome: null, charged_cost: 0.2, admitted_estimate: 0.2,
    cost_overage: 0, provider_request_id: null, failure_category: null }).execute());
  await enqueueJob(db, tenant, { identity: { ...identity, attempt_label: "third" },
    runner_name: "llm_judge", estimated_cost: 0.2 }, limits);
  expect((await claimJob(db, tenant, "third", limits)).kind).toBe("refused");
}));

integration("indexed attempt aggregation counts a large run without execution JSON", async () => scratchGrading(async (db, occurrence_id) => {
  expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("model") })).ok).toBe(true);
  const limits = { ...gradingLimits(), run_spend: 0.55, stage_spend: 0.55 };
  const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
    question_id: question.question_id, question_version: question.question_version,
    evaluator_definition_id: "model", config_digest: "config-1", attempt_label: "many-attempts" };
  const historical = await enqueueJob(db, tenant, { identity, runner_name: "llm_judge", estimated_cost: 0.001 }, limits);
  await withTenant(db, tenant, (trx) => trx.updateTable("observation.grading_job")
    .set({ state: "terminal" }).where("job_id", "=", historical.job_id).execute());
  await withTenant(db, tenant, (trx) => sql`INSERT INTO observation.grading_provider_attempt
    (producer, namespace, job_id, attempt, run_id, stage_id, request_sent, outcome,
     charged_cost, admitted_estimate, cost_overage)
    SELECT ${tenant.producer}, ${tenant.namespace}, ${historical.job_id}, series,
      ${historical.run_id}, ${historical.stage_id}, true, 'completed', 0.001, 0.001, 0
    FROM generate_series(1, 500) AS series`.execute(trx));
  await enqueueJob(db, tenant, { identity: { ...identity, attempt_label: "after-many" },
    runner_name: "llm_judge", estimated_cost: 0.1 }, limits);
  expect((await claimJob(db, tenant, "after-many", limits)).kind).toBe("refused");
}));
for (const cap of ["run_spend", "stage_spend", "run_concurrency", "stage_concurrency"] as const) {
  integration(`${cap} refuses paid work or defers at zero without changing eligibility`, async () => scratchGrading(async (db, occurrence_id) => {
    expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("model") })).ok).toBe(true);
    const limits = { ...gradingLimits(), run_spend: 10, stage_spend: 10, run_concurrency: 2, stage_concurrency: 2,
      [cap]: 0 };
    const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
      question_id: question.question_id, question_version: question.question_version,
      evaluator_definition_id: "model", config_digest: "config-1", attempt_label: cap };
    const job = await enqueueJob(db, tenant, { identity, runner_name: "llm_judge", estimated_cost: 0.2 }, limits);
    expect((await recordEligibility(db, tenant, { ...tenant, subject_occurrence_id: occurrence_id,
      question_id: question.question_id, question_version: question.question_version,
      tag: "eligible", payload: { evidence_set_id: evidence.evidence_set_id } })).ok).toBe(true);
    const claimed = await claimJob(db, tenant, "budget-worker", limits);
    if (cap.endsWith("spend")) {
      expect(claimed.kind).toBe("refused");
      expect(claimed.kind === "refused" && claimed.job.state).toBe("skipped_budget");
      const local = await enqueueJob(db, tenant, { identity: { ...identity, attempt_label: `${cap}-local` },
        runner_name: "stub_model" }, limits);
      const localClaim = await claimJob(db, tenant, "local-worker", limits);
      expect(localClaim.kind === "admitted" && localClaim.job.job_id).toBe(local.job_id);
    } else {
      expect(claimed.kind).toBe("deferred");
      const stored = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.grading_job")
        .selectAll().where("job_id", "=", job.job_id).executeTakeFirstOrThrow());
      expect(stored.state).toBe("queued");
    }
    expect((await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluation_execution").selectAll().execute()))).toHaveLength(0);
    const rows = await readEligibility(db, tenant, question.question_id, question.question_version);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tag).toBe("eligible");
  }));
}

integration("recorded provider cost consumes the next run budget", async () => scratchGrading(async (db, occurrence_id) => {
  expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("model") })).ok).toBe(true);
  const limits = { ...gradingLimits(), run_spend: 0.3, stage_spend: 1 };
  const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
    question_id: question.question_id, question_version: question.question_version,
    evaluator_definition_id: "model", config_digest: "config-1", attempt_label: "paid-1" };
  const paid: GradeRunner = { kind: "model", async run() { return { ok: true, value: {
    answer: { state: "answered", kind: "boolean", value: true }, cost: 0.25,
    external_execution_id: "request-1" } }; } };
  await enqueueJob(db, tenant, { identity, runner_name: "llm_judge", estimated_cost: 0.1 }, limits);
  await workOneJob(db, tenant, limits, "first", paid);
  const next = await enqueueJob(db, tenant, { identity: { ...identity, attempt_label: "paid-2" },
    runner_name: "llm_judge", estimated_cost: 0.1 }, limits);
  expect((await claimJob(db, tenant, "second", limits)).kind).toBe("refused");
  expect((await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluation_execution")
    .selectAll().execute()))).toHaveLength(1);
  expect(next.job_id).toBeTruthy();
}));

integration("reported overage blocks the next admission", async () => scratchGrading(async (db, occurrence_id) => {
  expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("model") })).ok).toBe(true);
  const limits = { ...gradingLimits(), run_spend: 0.25, stage_spend: 0.25 };
  const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
    question_id: question.question_id, question_version: question.question_version,
    evaluator_definition_id: "model", config_digest: "config-1", attempt_label: "overage-first" };
  const over: GradeRunner = { kind: "model", async run() { return { ok: true, value: {
    answer: { state: "answered", kind: "boolean", value: true }, cost: 0.3 } }; } };
  const first = await enqueueJob(db, tenant, { identity, runner_name: "llm_judge", estimated_cost: 0.1 }, limits);
  await workOneJob(db, tenant, limits, "overage-worker", over);
  const attempt = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.grading_provider_attempt")
    .selectAll().where("job_id", "=", first.job_id).executeTakeFirstOrThrow());
  expect(attempt.charged_cost).toBeCloseTo(0.3);
  expect(attempt.cost_overage).toBeCloseTo(0.2);
  await enqueueJob(db, tenant, { identity: { ...identity, attempt_label: "overage-second" },
    runner_name: "llm_judge", estimated_cost: 0.1 }, limits);
  expect((await claimJob(db, tenant, "after-overage", limits)).kind).toBe("refused");
}));

integration("active cost reservations prevent concurrent claims from exceeding a spend cap", async () => scratchGrading(async (db, occurrence_id) => {
  expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("model") })).ok).toBe(true);
  const limits = { ...gradingLimits(), run_spend: 0.3, stage_spend: 1,
    run_concurrency: 2, stage_concurrency: 2 };
  const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
    question_id: question.question_id, question_version: question.question_version,
    evaluator_definition_id: "model", config_digest: "config-1", attempt_label: "reserved-1" };
  await enqueueJob(db, tenant, { identity, runner_name: "llm_judge", estimated_cost: 0.2 }, limits);
  const second = await enqueueJob(db, tenant, { identity: { ...identity, attempt_label: "reserved-2" },
    runner_name: "llm_judge", estimated_cost: 0.2 }, limits);
  expect((await claimJob(db, tenant, "first", limits)).kind).toBe("admitted");
  const skipped = await claimJob(db, tenant, "second", limits);
  expect(skipped.kind !== "deferred" && skipped.job.job_id).toBe(second.job_id);
  expect(skipped.kind === "refused" && skipped.job.state).toBe("skipped_budget");
}));

integration("unknown provider cost is charged at the admitted estimate", async () => scratchGrading(async (db, occurrence_id) => {
  expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("model") })).ok).toBe(true);
  const limits = { ...gradingLimits(), run_spend: 0.3, stage_spend: 1 };
  const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
    question_id: question.question_id, question_version: question.question_version,
    evaluator_definition_id: "model", config_digest: "config-1", attempt_label: "unknown-cost-1" };
  const noCost: GradeRunner = { kind: "model", async run() { return { ok: true, value: {
    answer: { state: "answered", kind: "boolean", value: true }, external_execution_id: "request-no-cost" } }; } };
  await enqueueJob(db, tenant, { identity, runner_name: "llm_judge", estimated_cost: 0.2 }, limits);
  await workOneJob(db, tenant, limits, "first", noCost);
  const execution = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluation_execution")
    .selectAll().executeTakeFirstOrThrow());
  expect(execution.provider_attempts).toMatchObject([{ cost: 0.2 }]);
  await enqueueJob(db, tenant, { identity: { ...identity, attempt_label: "unknown-cost-2" },
    runner_name: "llm_judge", estimated_cost: 0.2 }, limits);
  expect((await claimJob(db, tenant, "second", limits)).kind).toBe("refused");
}));

integration("budget refusal on retry closes the earlier running execution without launching again", async () => scratchGrading(async (db, occurrence_id) => {
  expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("model") })).ok).toBe(true);
  const limits = { ...gradingLimits(), run_spend: 1, stage_spend: 1 };
  const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
    question_id: question.question_id, question_version: question.question_version,
    evaluator_definition_id: "model", config_digest: "config-1", attempt_label: "retry-budget" };
  const job = await enqueueJob(db, tenant, { identity, runner_name: "llm_judge", estimated_cost: 0.2 }, limits);
  const failed: GradeRunner = { kind: "model", async run() { return { ok: false, error: {
    operation: "provider", entity_id: "model", detail: "unavailable", category: "http_error" } }; } };
  await workOneJob(db, tenant, limits, "first", failed);
  const denied = await claimJob(db, tenant, "second", { ...limits, run_spend: 0.3 });
  expect(denied.kind !== "deferred" && denied.job.job_id).toBe(job.job_id);
  expect(denied.kind === "refused" && denied.job.state).toBe("terminal");
  expect(denied.kind === "refused" && denied.terminal_cause).toBe("budget_exceeded");
  const execution = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluation_execution")
    .selectAll().executeTakeFirstOrThrow());
  expect(execution.status).toBe("failed");
  expect(execution.ended_at).not.toBeNull();
  expect(execution.provider_attempts).toMatchObject([{ cost: 0.2, status: "failed" }]);
}));

integration("a provider call is charged before it is dispatched, so an interrupted worker leaves it charged",
  async () => scratchGrading(async (db, occurrence_id) => {
    expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("model") })).ok).toBe(true);
    // Cap 0.5 against two 0.3 calls: the second must be refused on the first call's cost alone.
    const limits = { ...gradingLimits(), run_spend: 0.5, stage_spend: 1, run_concurrency: 2, stage_concurrency: 2 };
    const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
      question_id: question.question_id, question_version: question.question_version,
      evaluator_definition_id: "model", config_digest: "config-1", attempt_label: "crashed-1" };

    // A worker that dies mid-call persists nothing after the fact, so the charge has to be on
    // record before the provider is reached. The runner observes the state at that moment.
    let inFlight: readonly Record<string, unknown>[] = [];
    const observing: GradeRunner = { kind: "model", async run() {
      const rows = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluation_execution")
        .selectAll().execute());
      inFlight = (rows[0]?.provider_attempts ?? []) as readonly Record<string, unknown>[];
      return { ok: true, value: { answer: { state: "answered", kind: "boolean", value: true },
        cost: 0.3, external_execution_id: "request-1" } };
    } };
    await enqueueJob(db, tenant, { identity, runner_name: "llm_judge", estimated_cost: 0.3 }, limits);
    await workOneJob(db, tenant, limits, "crashing-worker", observing);

    // Already charged at the admitted estimate while the call was still outstanding.
    expect(inFlight.some((attempt) => attempt.status === "dispatched" && attempt.cost === 0.3)).toBe(true);
    // Settled in place, so the one call is charged once rather than twice.
    const settled = (await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluation_execution")
      .selectAll().execute()))[0]?.provider_attempts as readonly Record<string, unknown>[];
    expect(settled.filter((attempt) => attempt.job_id === inFlight[0]?.job_id)).toHaveLength(1);
    expect(settled.every((attempt) => attempt.status !== "dispatched")).toBe(true);

    // A second call of the same size no longer fits under the cap.
    await enqueueJob(db, tenant, { identity: { ...identity, attempt_label: "crashed-2" },
      runner_name: "llm_judge", estimated_cost: 0.3 }, limits);
    expect((await claimJob(db, tenant, "next-worker", limits)).kind).toBe("refused");
  }));

integration("a provider price above the admitted estimate is recorded as an overage",
  async () => scratchGrading(async (db, occurrence_id) => {
    expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("model") })).ok).toBe(true);
    const limits = { ...gradingLimits(), run_spend: 5, stage_spend: 5, run_concurrency: 4, stage_concurrency: 4 };
    const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
      question_id: question.question_id, question_version: question.question_version,
      evaluator_definition_id: "model", config_digest: "config-1", attempt_label: "overage-1" };
    const priced = (cost: number | undefined): GradeRunner => ({ kind: "model", async run() {
      return { ok: true, value: { answer: { state: "answered", kind: "boolean", value: true },
        ...(cost === undefined ? {} : { cost }), external_execution_id: "request-1" } };
    } });
    const attemptsFor = async (label: string): Promise<readonly Record<string, unknown>[]> => {
      const rows = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluation_execution")
        .selectAll().where("attempt_label", "=", label).execute());
      return (rows[0]?.provider_attempts ?? []) as readonly Record<string, unknown>[];
    };

    // Priced above the estimate: charged the real cost, and the overshoot is on record.
    await enqueueJob(db, tenant, { identity, runner_name: "llm_judge", estimated_cost: 0.1 }, limits);
    await workOneJob(db, tenant, limits, "over", priced(0.3));
    const over = (await attemptsFor("overage-1"))[0];
    expect(over?.cost).toBe(0.3);
    expect(over?.estimated_cost).toBe(0.1);
    expect(over?.cost_overage).toBeCloseTo(0.2, 10);

    // Priced at or under the estimate: charged the real cost, no overage recorded.
    await enqueueJob(db, tenant, { identity: { ...identity, attempt_label: "overage-2" },
      runner_name: "llm_judge", estimated_cost: 0.3 }, limits);
    await workOneJob(db, tenant, limits, "under", priced(0.1));
    const under = (await attemptsFor("overage-2"))[0];
    expect(under?.cost).toBe(0.1);
    expect(Object.hasOwn(under ?? {}, "cost_overage")).toBe(false);

    // No reported cost: the charge is the estimate, so there is nothing to overshoot.
    await enqueueJob(db, tenant, { identity: { ...identity, attempt_label: "overage-3" },
      runner_name: "llm_judge", estimated_cost: 0.2 }, limits);
    await workOneJob(db, tenant, limits, "silent", priced(undefined));
    const silent = (await attemptsFor("overage-3"))[0];
    expect(silent?.cost).toBe(0.2);
    expect(Object.hasOwn(silent ?? {}, "cost_overage")).toBe(false);
  }));
