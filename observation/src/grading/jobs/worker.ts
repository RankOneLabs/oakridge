import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { EvaluationIdentity } from "../execution";
import type { RunnerResult } from "../runner";
import { checkDisclosure } from "../disclosure";
import type { GradeRunner } from "../../ports/grade-runner";
import { deterministicChecker } from "../../runners/deterministic-checker";
import { coverageChecker } from "../../runners/coverage-checker";
import { stubModelRunner } from "../../runners/stub-model";
import { createSystemOneRunner } from "../../runners/jev-direct";
import { FASTINO_SYSTEM_ONE_BASE_URL } from "../../runners/fastino-glide";
import { createLlmJudgeRunner } from "../../runners/llm-judge";
import { err } from "../../domain/primitives";
import { runGrade, startDelegatedExecution } from "../../storage/grading-store";
import { claimJob, type GradingJob } from "../../storage/grading-job-store";
import { withTenant, type Database, type TenantScope } from "../../storage/database";
import { gradingLimits, type GradingLimits } from "./budget";

const localRunners: Readonly<Record<string, GradeRunner>> = { deterministic: deterministicChecker,
  coverage: coverageChecker, stub_model: stubModelRunner };
function runnerFor(name: string, limits: GradingLimits, env: NodeJS.ProcessEnv): GradeRunner | undefined {
  if (name === "jev_direct") return createSystemOneRunner({ operation: name,
    base_url: "https://api.typesafe.ai/v1", api_key: env.TYPESAFE_API_KEY,
    deadline_ms: limits.provider_deadline_ms });
  if (name === "fastino_glide") return createSystemOneRunner({ operation: name,
    base_url: FASTINO_SYSTEM_ONE_BASE_URL, api_key: env.FASTINO_API_KEY,
    deadline_ms: limits.provider_deadline_ms });
  if (name === "llm_judge") return createLlmJudgeRunner({ api_key: env.OBSERVATION_LLM_JUDGE_API_KEY,
    base_url: env.OBSERVATION_LLM_JUDGE_BASE_URL ?? "https://api.openai.com/v1",
    deadline_ms: limits.provider_deadline_ms });
  return localRunners[name];
}
function identity(job: GradingJob): EvaluationIdentity {
  return { subject_occurrence_id: job.subject_occurrence_id as EvaluationIdentity["subject_occurrence_id"],
    evidence_set_id: job.evidence_set_id as EvaluationIdentity["evidence_set_id"],
    question_id: job.question_id as EvaluationIdentity["question_id"], question_version: job.question_version,
    evaluator_definition_id: job.evaluator_definition_id, config_digest: job.config_digest,
    attempt_label: job.attempt_label };
}
/** One claim performs one attempt. Claim and persist are independent transactions. */
export async function workOneJob(db: Database, tenant: TenantScope, limits: GradingLimits = gradingLimits(),
  owner: string = randomUUID(), runner_override?: GradeRunner,
  env: NodeJS.ProcessEnv = process.env): Promise<GradingJob | null> {
  const job = await claimJob(db, tenant, owner, limits);
  if (!job || job.state !== "claimed") return job;
  const base = runner_override ?? runnerFor(job.runner_name, limits, env);
  if (!base) throw new Error(`unknown runner ${job.runner_name}`);
  const intended = identity(job);
  let execution_id: string | null = null;
  if (base.kind === "model") {
    const started = await startDelegatedExecution(db, tenant, intended, job.reviewed_commit ?? undefined);
    if (!started.ok) throw new Error(started.error.detail);
    execution_id = started.value.execution_id;
  }
  const guarded: GradeRunner = { kind: base.kind, async run(context) {
    if (["jev_direct", "fastino_glide", "llm_judge"].includes(job.runner_name)) {
      const disclosure = checkDisclosure(context.evidence, context.evaluator.provider);
      if (!disclosure.ok) return err(disclosure.error);
      await withTenant(db, tenant, (trx) => trx.updateTable("observation.grading_job")
        .set({ disclosure: sql`${JSON.stringify(disclosure.value)}::jsonb` })
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("job_id", "=", job.job_id).where("state", "=", "claimed")
        .where("lease_owner", "=", owner).execute());
    }
    let response: RunnerResult;
    try { response = await base.run(context); }
    catch { response = err({ operation: "grade_runner", entity_id: context.evaluator.evaluator_definition_id,
      detail: "runner failed" }); }
    if (execution_id) {
      const attempt = { job_id: job.job_id, attempt: job.attempts,
        status: response.ok ? "completed" : "failed",
        request_id: response.ok ? response.value.external_execution_id ?? null
          : response.error.external_execution_id ?? null,
        cost: response.ok ? response.value.cost ?? job.estimated_cost
          : response.error.cost ?? job.estimated_cost };
      await withTenant(db, tenant, (trx) => trx.updateTable("observation.evaluation_execution")
        .set({ provider_attempts: sql`provider_attempts || ${JSON.stringify([attempt])}::jsonb` })
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("execution_id", "=", execution_id).execute());
    }
    return response;
  } };
  await runGrade(db, tenant, { identity: intended, reviewed_commit: job.reviewed_commit ?? undefined,
    runner: guarded, lease: { job_id: job.job_id, owner } });
  return job;
}
export interface GradingWorker { stop(): Promise<void> }
/** The HTTP process remains available when the independently stoppable worker is halted. */
export function startGradingWorker(db: Database, tenants: readonly TenantScope[],
  limits: GradingLimits = gradingLimits(), env: NodeJS.ProcessEnv = process.env): GradingWorker {
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      for (const tenant of tenants) {
        if (stopped) break;
        try { await workOneJob(db, tenant, limits, randomUUID(), undefined, env); }
        catch (cause) { console.error("grading worker attempt failed", String(cause)); }
      }
      if (!stopped) await Bun.sleep(250);
    }
  })();
  return { stop: async () => { stopped = true; await loop; } };
}
