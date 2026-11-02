import { expect, test } from "bun:test";
import { sql } from "kysely";
import { openDatabase, withTenant, type Database } from "../src/storage/database";
import { registerGradingContext, runGrade, startDelegatedExecution } from "../src/storage/grading-store";
import { claimJob, enqueueJob } from "../src/storage/grading-job-store";
import { workOneJob } from "../src/grading/jobs/worker";
import { gradingLimits } from "../src/grading/jobs/budget";
import type { GradeRunner } from "../src/ports/grade-runner";
import type { ProviderFailureCategory } from "../src/grading/runner";
import { tenant, question, evidence, evaluator, scratchGrading } from "./grading-fixture";

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
const limits = { ...gradingLimits(), lease_ms: 1_000, retry_limit: 3, run_spend: 10, stage_spend: 10 };
const good: GradeRunner = { kind: "model", async run() { return { ok: true, value: {
  answer: { state: "answered", kind: "boolean", value: true }, external_execution_id: "request-old", cost: 0.2 } }; } };
const other: GradeRunner = { kind: "model", async run() { return { ok: true, value: {
  answer: { state: "answered", kind: "boolean", value: false }, external_execution_id: "request-new", cost: 0.3 } }; } };
async function setup(db: Database, occurrence_id: Parameters<typeof enqueueJob>[2]["identity"]["subject_occurrence_id"], label: string) {
  const registered = await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("model") });
  expect(registered.ok).toBe(true);
  const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
    question_id: question.question_id, question_version: question.question_version,
    evaluator_definition_id: "model", config_digest: "config-1", attempt_label: label };
  const job = await enqueueJob(db, tenant, { identity, runner_name: "llm_judge", estimated_cost: 0.1 }, limits);
  return { identity, job };
}
async function outcome(db: Database, job_id: string) {
  return withTenant(db, tenant, async (trx) => ({
    job: await trx.selectFrom("observation.grading_job").selectAll().where("job_id", "=", job_id).executeTakeFirstOrThrow(),
    grades: await trx.selectFrom("observation.grade_observation").selectAll().execute(),
    executions: await trx.selectFrom("observation.evaluation_execution").selectAll().execute(),
    attempts: await trx.selectFrom("observation.grading_provider_attempt")
      .selectAll().where("job_id", "=", job_id).orderBy("attempt").execute(),
  }));
}
for (const phase of ["before claim", "mid-provider request", "after response before persist", "during restart"] as const) {
  integration(`crash ${phase} reclaims to one canonical grade`, async () => scratchGrading(async (db, occurrence_id) => {
    const { identity, job } = await setup(db, occurrence_id, phase);
    let interrupted: Promise<unknown> | null = null;
    const paused: { release?: () => void } = {};
    if (phase !== "before claim") {
      if (phase === "mid-provider request") {
        let entered!: () => void;
        const started = new Promise<void>((resolve) => { entered = resolve; });
        const waiting = new Promise<void>((resolve) => { paused.release = resolve; });
        const suspended: GradeRunner = { kind: "model", async run() {
          entered(); await waiting; return good.run({} as never);
        } };
        interrupted = workOneJob(db, tenant, limits, "crashed-worker", suspended);
        await started;
      } else {
        const claimed = await claimJob(db, tenant, "crashed-worker", limits);
        expect(claimed.kind).toBe("admitted");
      }
      if (phase === "after response before persist" || phase === "during restart") {
        expect((await startDelegatedExecution(db, tenant, identity)).ok).toBe(true);
        if (phase === "after response before persist")
          expect((await good.run({} as never)).ok).toBe(true);
      }
      await withTenant(db, tenant, (trx) => trx.updateTable("observation.grading_job")
        .set({ lease_expires_at: new Date(Date.now() - 1) }).where("job_id", "=", job.job_id).execute());
    }
    if (phase === "during restart") {
      const database = await sql<{ name: string }>`SELECT current_database() AS name`.execute(db);
      const url = new URL(process.env.OAKRIDGE_TEST_DATABASE_URL!);
      url.pathname = "/" + database.rows[0]!.name;
      const restarted = openDatabase(url.href);
      try { await workOneJob(restarted, tenant, limits, "recovered-worker", good); }
      finally { await restarted.destroy(); }
    } else await workOneJob(db, tenant, limits, "recovered-worker", good);
    paused.release?.();
    if (interrupted) await interrupted;
    const stored = await outcome(db, job.job_id);
    expect(stored.job.state).toBe("terminal");
    expect(stored.grades).toHaveLength(1);
    expect(stored.executions).toHaveLength(1);
    expect(stored.grades[0]?.execution_id).toBe(stored.executions[0]?.execution_id);
    if (phase === "mid-provider request") {
      expect(stored.attempts).toHaveLength(2);
      expect(stored.attempts[0]).toMatchObject({ attempt: 1, request_sent: true,
        outcome: null, charged_cost: 0.1 });
      expect(stored.attempts[1]).toMatchObject({ attempt: 2, request_sent: true,
        outcome: "completed", charged_cost: 0.2 });
    }
  }));
}
integration("expired provider response is discarded after a second worker wins reclaim", async () => scratchGrading(async (db, occurrence_id) => {
  const { job } = await setup(db, occurrence_id, "late response");
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const slow: GradeRunner = { kind: "model", async run() { entered(); await waiting; return good.run({} as never); } };
  const old = workOneJob(db, tenant, limits, "old-worker", slow);
  await started;
  await withTenant(db, tenant, (trx) => trx.updateTable("observation.grading_job")
    .set({ lease_expires_at: new Date(Date.now() - 1) }).where("job_id", "=", job.job_id).execute());
  await workOneJob(db, tenant, limits, "new-worker", other);
  release();
  expect(await old).toMatchObject({ kind: "lost_lease", job_id: job.job_id, attempt: 1 });
  const stored = await outcome(db, job.job_id);
  expect(stored.grades).toHaveLength(1);
  expect(stored.grades[0]?.answer_payload).toEqual({ state: "answered", kind: "boolean", value: false });
  expect(stored.executions[0]?.provider_attempts).toMatchObject([
    { job_id: job.job_id, attempt: 1, status: "dispatched", cost: 0.1 },
    { job_id: job.job_id, attempt: 2, status: "completed", cost: 0.3 },
  ]);
}));

integration("failed provider request id and cost remain on the canonical execution", async () => scratchGrading(async (db, occurrence_id) => {
  const { job } = await setup(db, occurrence_id, "failed request");
  const failed: GradeRunner = { kind: "model", async run() { return { ok: false, error: {
    operation: "provider", entity_id: "model", detail: "HTTP 503",
    external_execution_id: "request-failed", cost: 0.04, category: "http_error" } }; } };
  await workOneJob(db, tenant, limits, "first", failed);
  expect((await outcome(db, job.job_id)).job.state).toBe("reclaimable");
  expect((await outcome(db, job.job_id)).executions[0]?.provider_attempts).toEqual([
    { job_id: job.job_id, attempt: 1, status: "failed", request_id: "request-failed", cost: 0.04, estimated_cost: 0.1 },
  ]);
  await workOneJob(db, tenant, limits, "second", good);
  const stored = await outcome(db, job.job_id);
  expect(stored.executions).toHaveLength(1);
  expect(stored.grades).toHaveLength(1);
  expect(stored.executions[0]?.provider_attempts).toMatchObject([
    { job_id: job.job_id, attempt: 1, status: "failed", request_id: "request-failed", cost: 0.04, estimated_cost: 0.1 },
    { job_id: job.job_id, attempt: 2, status: "completed", request_id: "request-old", cost: 0.2, estimated_cost: 0.1 },
  ]);
}));

integration("replay of a terminal execution terminalizes its claimed job without calling the runner", async () => scratchGrading(async (db, occurrence_id) => {
  const { identity, job } = await setup(db, occurrence_id, "terminal replay");
  expect((await runGrade(db, tenant, { identity, runner: good })).ok).toBe(true);
  let calls = 0;
  const unused: GradeRunner = { kind: "model", async run() { calls++; return good.run({} as never); } };
  await workOneJob(db, tenant, limits, "replay-worker", unused);
  const stored = await outcome(db, job.job_id);
  expect(calls).toBe(0);
  expect(stored.job.state).toBe("terminal");
  expect(stored.job.terminal_cause).toBeNull();
  expect(stored.grades).toHaveLength(1);
}));

integration("retry limit makes an expired claim terminal with a typed cause", async () => scratchGrading(async (db, occurrence_id) => {
  const { identity, job } = await setup(db, occurrence_id, "retry bound");
  const bounded = { ...limits, retry_limit: 0 };
  await withTenant(db, tenant, (trx) => trx.updateTable("observation.grading_job")
    .set({ retry_limit: 0 }).where("job_id", "=", job.job_id).execute());
  for (let attempt = 0; attempt < 1; attempt++) {
    expect((await claimJob(db, tenant, `owner-${attempt}`, bounded)).kind).toBe("admitted");
    if (attempt === 0) expect((await startDelegatedExecution(db, tenant, identity)).ok).toBe(true);
    await withTenant(db, tenant, (trx) => trx.updateTable("observation.grading_job")
      .set({ lease_expires_at: new Date(Date.now() - 1) }).where("job_id", "=", job.job_id).execute());
  }
  const exhausted = await claimJob(db, tenant, "last-owner", bounded);
  expect(exhausted.kind === "refused" && exhausted.job.state).toBe("terminal");
  expect(exhausted.kind === "refused" && exhausted.terminal_cause).toBe("retry_exhausted");
  const stored = await outcome(db, job.job_id);
  expect(stored.executions[0]?.status).toBe("failed");
  expect(stored.executions[0]?.ended_at).not.toBeNull();
}));

integration("retry migration preserves live total attempts and historical limits", async () => scratchGrading(async (db, occurrence_id) => {
  const { identity } = await setup(db, occurrence_id, "migration-seed");
  const states = ["queued", "claimed", "reclaimable", "terminal", "skipped_budget"] as const;
  const ids: string[] = [];
  for (const state of states) {
    const job = await enqueueJob(db, tenant, { identity: { ...identity, attempt_label: `migration-${state}` },
      runner_name: "stub_model" }, limits);
    ids.push(job.job_id);
    await withTenant(db, tenant, (trx) => trx.updateTable("observation.grading_job")
      .set({ state, retry_limit: 3, lease_owner: state === "claimed" ? "migration-owner" : null,
        lease_expires_at: state === "claimed" ? new Date(Date.now() + 60_000) : null })
      .where("job_id", "=", job.job_id).execute());
  }
  await sql`DROP TABLE observation.grading_provider_attempt`.execute(db);
  const migration = await Bun.file(new URL("../src/storage/migrations/0018_grading_attempt_accounting.sql", import.meta.url)).text();
  await sql.raw(migration).execute(db);
  const rows = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.grading_job")
    .select(["job_id", "state", "retry_limit"]).where("job_id", "in", ids).execute());
  expect(states.map((state) => rows.find((row) => row.state === state)?.retry_limit)).toEqual([2, 2, 2, 3, 3]);
}));

integration("failure categories decide retry count independently of operation name", async () => scratchGrading(async (db, occurrence_id) => {
  const { identity, job: seed } = await setup(db, occurrence_id, "category-seed");
  await withTenant(db, tenant, (trx) => trx.updateTable("observation.grading_job")
    .set({ state: "terminal" }).where("job_id", "=", seed.job_id).execute());
  const bounded = { ...limits, retry_limit: 1 };
  const categories: ProviderFailureCategory[] = ["unconfigured_credential", "invalid_request",
    "invalid_unclear_designation", "invalid_choice", "rate_limit", "timeout", "transport",
    "http_error", "invalid_response"];
  for (const category of categories) {
    const job = await enqueueJob(db, tenant, { identity: { ...identity, attempt_label: `category-${category}` },
      runner_name: "llm_judge", estimated_cost: 0.1 }, bounded);
    const failed: GradeRunner = { kind: "model", async run() { return { ok: false, error: {
      operation: "same-operation", entity_id: "model", detail: category, category } }; } };
    await workOneJob(db, tenant, bounded, `${category}-first`, failed);
    const retryable = ["rate_limit", "timeout", "transport", "http_error"].includes(category);
    expect((await outcome(db, job.job_id)).job.state).toBe(retryable ? "reclaimable" : "terminal");
    if (retryable) await workOneJob(db, tenant, bounded, `${category}-second`, failed);
    const stored = await outcome(db, job.job_id);
    expect(stored.job.attempts).toBe(retryable ? 2 : 1);
    expect(stored.job.terminal_cause).toBe(retryable ? "retry_exhausted"
      : category === "invalid_response" ? "invalid_outcome" : "runner_failed");
    expect(stored.attempts.map((attempt) => attempt.failure_category)).toEqual(
      Array.from({ length: retryable ? 2 : 1 }, () => category));
    // The override represents an already-sent request; category changes retryability, not its charge.
    expect(stored.attempts.every((attempt) => attempt.request_sent && attempt.charged_cost === 0.1)).toBe(true);
  }
}));

integration("runner exception detail is persisted at terminal settlement", async () => scratchGrading(async (db, occurrence_id) => {
  const { identity } = await setup(db, occurrence_id, "thrown");
  const bounded = { ...limits, retry_limit: 0 };
  await withTenant(db, tenant, (trx) => trx.updateTable("observation.grading_job")
    .set({ retry_limit: 0 }).where("attempt_label", "=", identity.attempt_label).execute());
  const throwing: GradeRunner = { kind: "model", async run() { throw new Error("provider socket broke at request 42"); } };
  await workOneJob(db, tenant, bounded, "throwing-worker", throwing);
  const stored = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluation_execution")
    .select("error").where("attempt_label", "=", identity.attempt_label).executeTakeFirstOrThrow());
  expect(stored.error).toContain("provider socket broke at request 42");
}));

integration("provider insufficient evidence records an abstain without retry", async () => scratchGrading(async (db, occurrence_id) => {
  const choice = { ...question, question_id: "abstain-question" as typeof question.question_id,
    response_kind: "choice" as const, allowed_values: ["yes", "insufficient_evidence"] };
  expect((await registerGradingContext(db, tenant, { question: choice, evidence,
    evaluator: evaluator("model") })).ok).toBe(true);
  const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
    question_id: choice.question_id, question_version: choice.question_version,
    evaluator_definition_id: "model", config_digest: "config-1", attempt_label: "abstain-provider" };
  const job = await enqueueJob(db, tenant, { identity, runner_name: "llm_judge", estimated_cost: 0.1 }, limits);
  const abstain: GradeRunner = { kind: "model", async run() { return { ok: true, value: {
    answer: { state: "abstain", kind: "choice", reason: "insufficient_evidence" } } }; } };
  await workOneJob(db, tenant, limits, "abstain-worker", abstain);
  const stored = await outcome(db, job.job_id);
  expect(stored.job.state).toBe("terminal");
  expect(stored.job.terminal_cause).toBeNull();
  expect(stored.job.attempts).toBe(1);
  expect(stored.grades[0]?.answer_state).toBe("abstain");
  expect(stored.attempts[0]?.failure_category).toBeNull();
}));

integration("dispatch refuses configuration or evidence changed after enqueue", async () => scratchGrading(async (db, occurrence_id) => {
  const { identity, job } = await setup(db, occurrence_id, "changed-config");
  await withTenant(db, tenant, (trx) => trx.updateTable("observation.evaluator_definition")
    .set({ config_digest: "changed" }).where("evaluator_definition_id", "=", "model").execute());
  await workOneJob(db, tenant, limits, "config-worker", good);
  expect((await outcome(db, job.job_id)).job).toMatchObject({ state: "terminal", terminal_cause: "ineligible" });
  await withTenant(db, tenant, (trx) => trx.updateTable("observation.evaluator_definition")
    .set({ config_digest: "config-1" }).where("evaluator_definition_id", "=", "model").execute());
  const evidenceJob = await enqueueJob(db, tenant, { identity: { ...identity, attempt_label: "changed-evidence" },
    runner_name: "llm_judge", estimated_cost: 0.1 }, limits);
  await withTenant(db, tenant, (trx) => trx.updateTable("observation.evidence_set")
    .set({ is_incomplete: true, incompleteness_reason: "source disappeared" })
    .where("evidence_set_id", "=", evidence.evidence_set_id).execute());
  await workOneJob(db, tenant, limits, "evidence-worker", good);
  expect((await outcome(db, evidenceJob.job_id)).job).toMatchObject({ state: "terminal", terminal_cause: "ineligible" });
  expect((await outcome(db, evidenceJob.job_id)).attempts).toMatchObject([
    { request_sent: false, outcome: "failed", charged_cost: 0 },
  ]);
}));

integration("duplicate delivery retains one job while an evaluator regrade adds another", async () => scratchGrading(async (db, occurrence_id) => {
  const { identity, job } = await setup(db, occurrence_id, "duplicate");
  const replay = await enqueueJob(db, tenant, { identity, runner_name: "stub_model" }, limits);
  expect(replay.job_id).toBe(job.job_id);
  await workOneJob(db, tenant, limits, "first", good);
  const revised = { ...evaluator("model"), evaluator_definition_id: "model-v2", config_digest: "config-2" };
  expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: revised })).ok).toBe(true);
  const another = await enqueueJob(db, tenant, { identity: { ...identity,
    evaluator_definition_id: "model-v2", config_digest: "config-2" }, runner_name: "stub_model" }, limits);
  expect(another.job_id).not.toBe(job.job_id);
  await workOneJob(db, tenant, limits, "second", other);
  const stored = await outcome(db, job.job_id);
  expect(stored.grades).toHaveLength(2);
  expect(stored.executions).toHaveLength(2);
}));

integration("restricted evidence terminates before runner invocation", async () => scratchGrading(async (db, occurrence_id) => {
  const restricted = { ...evidence, evidence_set_id: "restricted-evidence" as typeof evidence.evidence_set_id,
    references: [{ ref: "hidden", kind: "internal" as const, content: "secret", digest: "digest" }] };
  expect((await registerGradingContext(db, tenant, { question, evidence: restricted,
    evaluator: evaluator("model") })).ok).toBe(true);
  const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: restricted.evidence_set_id,
    question_id: question.question_id, question_version: question.question_version,
    evaluator_definition_id: "model", config_digest: "config-1", attempt_label: "restricted" };
  const job = await enqueueJob(db, tenant, { identity, runner_name: "jev_direct", estimated_cost: 0.1 }, limits);
  let calls = 0;
  const forbidden: GradeRunner = { kind: "model", async run() { calls++; return good.run({} as never); } };
  await workOneJob(db, tenant, limits, "restricted-worker", forbidden);
  const stored = await outcome(db, job.job_id);
  expect(calls).toBe(0);
  expect(stored.job.state).toBe("terminal");
  expect(stored.job.terminal_cause).toBe("disclosure_refused");
  expect(stored.job.disclosure).toBeNull();
  expect(JSON.stringify(stored)).not.toContain("secret");
}));

integration("queued local runner can grade internal evidence without outbound disclosure", async () => scratchGrading(async (db, occurrence_id) => {
  const internal = { ...evidence, evidence_set_id: "internal-evidence" as typeof evidence.evidence_set_id,
    references: [{ ref: "local", kind: "internal" as const, content: "kept-local", digest: "digest" }] };
  expect((await registerGradingContext(db, tenant, { question, evidence: internal,
    evaluator: evaluator("model") })).ok).toBe(true);
  const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: internal.evidence_set_id,
    question_id: question.question_id, question_version: question.question_version,
    evaluator_definition_id: "model", config_digest: "config-1", attempt_label: "local-internal" };
  const job = await enqueueJob(db, tenant, { identity, runner_name: "stub_model" }, limits);
  await workOneJob(db, tenant, limits, "local-worker", good);
  const stored = await outcome(db, job.job_id);
  expect(stored.job.state).toBe("terminal");
  expect(stored.job.disclosure).toBeNull();
  expect(stored.grades).toHaveLength(1);
}));

integration("reviewed commit changes the queued and execution identities together", async () => scratchGrading(async (db, occurrence_id) => {
  const { identity, job } = await setup(db, occurrence_id, "commit-aware");
  const revised = await enqueueJob(db, tenant, { identity, runner_name: "stub_model",
    reviewed_commit: "commit-2" }, limits);
  expect(revised.job_id).not.toBe(job.job_id);
  expect(revised.idempotency_digest).not.toBe(job.idempotency_digest);
  await workOneJob(db, tenant, limits, "first", good);
  await workOneJob(db, tenant, limits, "second", good);
  const stored = await outcome(db, job.job_id);
  expect(stored.grades).toHaveLength(2);
  expect(stored.executions).toHaveLength(2);
}));
