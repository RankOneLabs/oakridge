import { jsonText } from "../../storage/database";
import type { JsonText } from "../../storage/json-column-types";
import type { JsonValue } from "../../domain/primitives";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { EvaluationIdentity } from "../execution";
import { runnerEntry, type RunnerResult } from "../runner";
import { checkDisclosure } from "../disclosure";
import type { GradeRunner } from "../../ports/grade-runner";
import { err } from "../../domain/primitives";
import { runGrade, startDelegatedExecution } from "../../storage/grading-store";
import { claimJob, type GradingJob } from "../../storage/grading-job-store";
import { withTenant, type Database, type TenantScope } from "../../storage/database";
import { gradingLimits, type GradingLimits } from "./budget";

/** One provider call's audit record, stored in `evaluation_execution.provider_attempts`. */
export interface ProviderAttempt {
  readonly job_id: string;
  readonly attempt: number;
  readonly status: "dispatched" | "completed" | "failed";
  readonly request_id: string | null;
  /** What the run was charged: the provider's reported cost, or the admitted estimate. */
  readonly cost: number;
  /** The estimate admission reserved, kept so an attempt explains its own charge. */
  readonly estimated_cost: number;
  /** Present only when the provider priced the call above its admitted estimate. The cap was
   * already checked against the estimate, so this is the amount by which this one call
   * overshot it; recorded spend carries the real cost, so later admissions self-correct. */
  readonly cost_overage?: number;
  readonly external_processing_policy?: string;
}

function runnerFor(name: string, limits: GradingLimits, env: NodeJS.ProcessEnv): GradeRunner | undefined {
  return runnerEntry(name)?.factory(limits.provider_deadline_ms, env);
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
    if (runnerEntry(job.runner_name)?.network) {
      const disclosure = checkDisclosure(context.evidence, context.evaluator.provider);
      if (!disclosure.ok) return err(disclosure.error);
      await withTenant(db, tenant, (trx) => trx.updateTable("observation.grading_job")
        .set({ disclosure: sql`${jsonText(disclosure.value)}::jsonb` })
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("job_id", "=", job.job_id).where("state", "=", "claimed")
        .where("lease_owner", "=", owner).execute());
    }
    const policy = env.OBSERVATION_EXTERNAL_PROCESSING_POLICY
      ? { external_processing_policy: env.OBSERVATION_EXTERNAL_PROCESSING_POLICY } : {};
    // A paid call whose worker dies before persisting its outcome must still be charged, so the
    // attempt is recorded as dispatched at its admitted estimate *before* the provider is called.
    // Budget admission counts a dispatched attempt at that estimate; settling it below replaces
    // the row with the real cost. Without this an interrupted call is invisible to both the spend
    // and the reservation once its lease expires, and the next call is admitted against zero.
    const dispatched: ProviderAttempt = { job_id: job.job_id, attempt: job.attempts,
      status: "dispatched", ...policy, request_id: null, cost: job.estimated_cost,
      estimated_cost: job.estimated_cost };
    if (execution_id) await withTenant(db, tenant, (trx) => trx.updateTable("observation.evaluation_execution")
      .set({ provider_attempts: sql<JsonText<JsonValue>>`provider_attempts || ${jsonText([dispatched])}::jsonb` })
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("execution_id", "=", execution_id).execute());
    let response: RunnerResult;
    try { response = await base.run(context); }
    catch { response = err({ operation: "grade_runner", entity_id: context.evaluator.evaluator_definition_id,
      detail: "runner failed" }); }
    if (execution_id) {
      // Only a provider-reported cost can overshoot, and only against a positive estimate:
      // when no cost is reported the charge *is* the estimate, and a local runner enqueued
      // without an estimate reserved nothing to overshoot. Network grading always carries one.
      const reported_cost = response.ok ? response.value.cost ?? null : response.error.cost ?? null;
      const overage = job.estimated_cost > 0 && reported_cost !== null && reported_cost > job.estimated_cost
        ? { cost_overage: reported_cost - job.estimated_cost } : {};
      const attempt: ProviderAttempt = { job_id: job.job_id, attempt: job.attempts,
        status: response.ok ? "completed" : "failed", ...policy,
        request_id: response.ok ? response.value.external_execution_id ?? null
          : response.error.external_execution_id ?? null,
        cost: reported_cost ?? job.estimated_cost, estimated_cost: job.estimated_cost, ...overage };
      // Settle in place: the dispatched row for this job and attempt becomes the real outcome,
      // so one call is charged once whether or not it reached the provider.
      await withTenant(db, tenant, (trx) => trx.updateTable("observation.evaluation_execution")
        .set({ provider_attempts: sql<JsonText<JsonValue>>`(
          SELECT COALESCE(jsonb_agg(entry ORDER BY ordinality), '[]'::jsonb)
          FROM jsonb_array_elements(provider_attempts) WITH ORDINALITY AS t(entry, ordinality)
          WHERE NOT (entry->>'job_id' = ${job.job_id}
            AND (entry->>'attempt')::int = ${job.attempts}
            AND entry->>'status' = 'dispatched')
        ) || ${jsonText([attempt])}::jsonb` })
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
