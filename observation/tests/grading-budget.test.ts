import { expect, test } from "bun:test";
import { withTenant } from "../src/storage/database";
import { enqueueJob, claimJob } from "../src/storage/grading-job-store";
import { gradingLimits } from "../src/grading/jobs/budget";
import { readEligibility, recordEligibility } from "../src/storage/eligibility-store";
import { eligibilityExclusionCounts } from "../src/grading/eligibility";
import { exclusionReason } from "../src/grading/eligibility";
import { exclusionCounts, makePopulationManifest } from "../src/langfuse/population-manifest";
import { registerGradingContext } from "../src/storage/grading-store";
import { workOneJob } from "../src/grading/jobs/worker";
import type { GradeRunner } from "../src/ports/grade-runner";
import { tenant, question, evidence, evaluator, scratchGrading } from "./grading-fixture";
const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
for (const cap of ["run_spend", "stage_spend", "run_concurrency", "stage_concurrency"] as const) {
  integration(`${cap} skips without execution and records eligibility`, async () => scratchGrading(async (db, occurrence_id) => {
    expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("model") })).ok).toBe(true);
    const limits = { ...gradingLimits(), run_spend: 10, stage_spend: 10, run_concurrency: 2, stage_concurrency: 2,
      [cap]: cap.endsWith("spend") ? 0.1 : 0 };
    const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
      question_id: question.question_id, question_version: question.question_version,
      evaluator_definition_id: "model", config_digest: "config-1", attempt_label: cap };
    const job = await enqueueJob(db, tenant, { identity, runner_name: "stub_model", estimated_cost: 0.2 }, limits);
    expect((await recordEligibility(db, tenant, { ...tenant, subject_occurrence_id: occurrence_id,
      question_id: question.question_id, question_version: question.question_version,
      tag: "eligible", payload: { evidence_set_id: evidence.evidence_set_id } })).ok).toBe(true);
    const claimed = await claimJob(db, tenant, "budget-worker", limits);
    expect(claimed?.state).toBe("skipped_budget");
    expect((await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluation_execution").selectAll().execute()))).toHaveLength(0);
    const rows = await readEligibility(db, tenant, question.question_id, question.question_version);
    expect(rows).toHaveLength(2);
    expect(eligibilityExclusionCounts(rows).skipped_budget).toBe(1);
    const skipped = rows.find((row) => row.tag === "skipped_budget");
    if (!skipped) throw new Error("stored budget exclusion missing");
    const reason = exclusionReason(skipped);
    if (!reason) throw new Error("stored budget exclusion has no population reason");
    const manifest = makePopulationManifest({ manifest_id: `budget-${cap}`, projection_version: "v1",
      question_pins: [{ question_id: question.question_id, question_version: question.question_version }],
      selected: [{ occurrence_id: skipped.subject_occurrence_id, question_id: skipped.question_id,
        question_version: skipped.question_version, evidence, stratum: "known_failure",
        disposition: "excluded", reason }] });
    expect(manifest.ok).toBe(true);
    if (manifest.ok) {
      expect(manifest.value.membership[0]?.reason.kind).toBe("skipped_budget");
      expect(exclusionCounts(manifest.value)[0]?.skipped_budget).toBe(1);
    }
    expect(claimed?.job_id).toBe(job.job_id);
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
  await enqueueJob(db, tenant, { identity, runner_name: "stub_model", estimated_cost: 0.1 }, limits);
  await workOneJob(db, tenant, limits, "first", paid);
  const next = await enqueueJob(db, tenant, { identity: { ...identity, attempt_label: "paid-2" },
    runner_name: "stub_model", estimated_cost: 0.1 }, limits);
  expect((await claimJob(db, tenant, "second", limits))?.state).toBe("skipped_budget");
  expect((await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluation_execution")
    .selectAll().execute()))).toHaveLength(1);
  expect(next.job_id).toBeTruthy();
}));

integration("active cost reservations prevent concurrent claims from exceeding a spend cap", async () => scratchGrading(async (db, occurrence_id) => {
  expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("model") })).ok).toBe(true);
  const limits = { ...gradingLimits(), run_spend: 0.3, stage_spend: 1,
    run_concurrency: 2, stage_concurrency: 2 };
  const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
    question_id: question.question_id, question_version: question.question_version,
    evaluator_definition_id: "model", config_digest: "config-1", attempt_label: "reserved-1" };
  const first = await enqueueJob(db, tenant, { identity, runner_name: "stub_model", estimated_cost: 0.2 }, limits);
  const second = await enqueueJob(db, tenant, { identity: { ...identity, attempt_label: "reserved-2" },
    runner_name: "stub_model", estimated_cost: 0.2 }, limits);
  expect((await claimJob(db, tenant, "first", limits))?.job_id).toBe(first.job_id);
  const skipped = await claimJob(db, tenant, "second", limits);
  expect(skipped?.job_id).toBe(second.job_id);
  expect(skipped?.state).toBe("skipped_budget");
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
  expect((await claimJob(db, tenant, "second", limits))?.state).toBe("skipped_budget");
}));

integration("budget refusal on retry closes the earlier running execution without launching again", async () => scratchGrading(async (db, occurrence_id) => {
  expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("model") })).ok).toBe(true);
  const limits = { ...gradingLimits(), run_spend: 1, stage_spend: 1 };
  const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
    question_id: question.question_id, question_version: question.question_version,
    evaluator_definition_id: "model", config_digest: "config-1", attempt_label: "retry-budget" };
  const job = await enqueueJob(db, tenant, { identity, runner_name: "llm_judge", estimated_cost: 0.2 }, limits);
  const failed: GradeRunner = { kind: "model", async run() { return { ok: false, error: {
    operation: "provider", entity_id: "model", detail: "unavailable" } }; } };
  await workOneJob(db, tenant, limits, "first", failed);
  const denied = await claimJob(db, tenant, "second", { ...limits, run_spend: 0.3 });
  expect(denied?.job_id).toBe(job.job_id);
  expect(denied?.state).toBe("terminal");
  expect(denied?.terminal_cause).toBe("budget_exceeded");
  const execution = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluation_execution")
    .selectAll().executeTakeFirstOrThrow());
  expect(execution.status).toBe("failed");
  expect(execution.ended_at).not.toBeNull();
  expect(execution.provider_attempts).toMatchObject([{ cost: 0.2, status: "failed" }]);
}));
