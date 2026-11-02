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
import { claimJob, type ClaimOutcome, type GradingJob } from "../../storage/grading-job-store";
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
export type WorkOutcome = ClaimOutcome | { readonly kind: "lost_lease"; readonly job_id: string; readonly attempt: number }
  | { readonly kind: "processed"; readonly job: GradingJob };
export async function workOneJob(db: Database, tenant: TenantScope, limits: GradingLimits = gradingLimits(),
  owner: string = randomUUID(), runner_override?: GradeRunner,
  env: NodeJS.ProcessEnv = process.env): Promise<WorkOutcome> {
  const claim = await claimJob(db, tenant, owner, limits);
  if (claim.kind !== "admitted") return claim;
  const job = claim.job;
  const isNetwork = runnerEntry(job.runner_name)?.network === true;
  const policy = env.OBSERVATION_EXTERNAL_PROCESSING_POLICY
    ? { external_processing_policy: env.OBSERVATION_EXTERNAL_PROCESSING_POLICY } : {};
  if (isNetwork) await withTenant(db, tenant, (trx) => trx.insertInto("observation.grading_provider_attempt")
    .values({ producer: tenant.producer, namespace: tenant.namespace, job_id: job.job_id,
      attempt: job.attempts, run_id: job.run_id, stage_id: job.stage_id,
      request_sent: false, outcome: null, charged_cost: 0, admitted_estimate: job.estimated_cost,
      cost_overage: 0, provider_request_id: null, failure_category: null })
    .onConflict((conflict) => conflict.columns(["producer", "namespace", "job_id", "attempt"]).doNothing()).execute());
  const base = runner_override ?? runnerFor(job.runner_name, limits, env);
  if (!base) throw new Error(`unknown runner ${job.runner_name}`);
  const intended = identity(job);
  let execution_id: string | null = null;
  if (base.kind === "model") {
    const started = await startDelegatedExecution(db, tenant, intended, job.reviewed_commit ?? undefined);
    if (!started.ok) {
      await withTenant(db, tenant, async (trx) => {
        const ended = await trx.updateTable("observation.grading_job")
          .set({ state: "terminal", terminal_cause: "ineligible", lease_owner: null,
            lease_expires_at: null, updated_at: new Date() })
          .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
          .where("job_id", "=", job.job_id).where("state", "=", "claimed")
          .where("lease_owner", "=", owner).where("attempts", "=", job.attempts)
          .returning("job_id").executeTakeFirst();
        if (ended && isNetwork) await trx.updateTable("observation.grading_provider_attempt")
          .set({ outcome: "failed", updated_at: new Date() })
          .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
          .where("job_id", "=", job.job_id).where("attempt", "=", job.attempts).execute();
      });
      return { kind: "processed", job };
    }
    execution_id = started.value.execution_id;
  }
  const guarded: GradeRunner = { kind: base.kind, async run(context) {
    if (isNetwork) {
      const disclosure = checkDisclosure(context.evidence, context.evaluator.provider);
      if (!disclosure.ok) {
        await withTenant(db, tenant, (trx) => trx.updateTable("observation.grading_provider_attempt")
          .set({ outcome: "failed", updated_at: new Date() })
          .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
          .where("job_id", "=", job.job_id).where("attempt", "=", job.attempts).execute());
        return err(disclosure.error);
      }
      await withTenant(db, tenant, (trx) => trx.updateTable("observation.grading_job")
        .set({ disclosure: sql`${jsonText(disclosure.value)}::jsonb` })
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("job_id", "=", job.job_id).where("state", "=", "claimed")
        .where("lease_owner", "=", owner).where("attempts", "=", job.attempts)
        .where("lease_expires_at", ">", new Date()).execute());
    }
    let wasSent = false;
    const onRequest = async (): Promise<boolean> => {
      if (!isNetwork) return true;
      if (wasSent) return true;
      const sent = await withTenant(db, tenant, async (trx) => {
        const claim = await trx.selectFrom("observation.grading_job").select(["state", "lease_owner", "attempts", "lease_expires_at"])
          .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
          .where("job_id", "=", job.job_id).forUpdate().executeTakeFirst();
        if (claim?.state !== "claimed" || claim.lease_owner !== owner || claim.attempts !== job.attempts
          || !claim.lease_expires_at || claim.lease_expires_at.getTime() <= Date.now()) return false;
        await trx.updateTable("observation.grading_provider_attempt")
          .set({ request_sent: true, charged_cost: job.estimated_cost, updated_at: new Date() })
          .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
          .where("job_id", "=", job.job_id).where("attempt", "=", job.attempts).execute();
        if (execution_id) {
          const dispatched: ProviderAttempt = { job_id: job.job_id, attempt: job.attempts,
            status: "dispatched", ...policy, request_id: null, cost: job.estimated_cost,
            estimated_cost: job.estimated_cost };
          await trx.updateTable("observation.evaluation_execution")
            .set({ provider_attempts: sql<JsonText<JsonValue>>`provider_attempts || ${jsonText([dispatched])}::jsonb` })
            .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
            .where("execution_id", "=", execution_id).execute();
        }
        return true;
      });
      wasSent = sent;
      return sent;
    };
    let response: RunnerResult;
    try {
      // Test doubles stand in for an already-issued provider request. Production network runners
      // invoke onRequest after preflight and immediately before their transport call.
      if (runner_override && isNetwork) await onRequest();
      response = await base.run(context, onRequest);
    } catch (cause) { response = err({ operation: "grade_runner", entity_id: context.evaluator.evaluator_definition_id,
      detail: String(cause), category: wasSent ? "transport" : "invalid_request" }); }
    if (isNetwork) {
      const reported_cost = response.ok ? response.value.cost ?? null : response.error.cost ?? null;
      const nonbillable = !response.ok && (["unconfigured_credential", "invalid_request",
        "invalid_unclear_designation", "invalid_choice"] as const)
        .some((category) => category === response.error.category);
      const cost = wasSent && !nonbillable ? reported_cost ?? job.estimated_cost : 0;
      const overage = cost > 0 && reported_cost !== null ? Math.max(0, reported_cost - job.estimated_cost) : 0;
      const request_id = response.ok ? response.value.external_execution_id ?? null
        : response.error.external_execution_id ?? null;
      await withTenant(db, tenant, async (trx) => {
        const current = await trx.selectFrom("observation.grading_job")
          .select(["state", "lease_owner", "attempts", "lease_expires_at"])
          .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
          .where("job_id", "=", job.job_id).forUpdate().executeTakeFirst();
        if (current?.state !== "claimed" || current.lease_owner !== owner || current.attempts !== job.attempts
          || !current.lease_expires_at || current.lease_expires_at.getTime() <= Date.now()) return;
        await trx.updateTable("observation.grading_provider_attempt")
          .set({ outcome: response.ok ? "completed" : "failed", charged_cost: cost,
            cost_overage: overage, provider_request_id: request_id,
            failure_category: response.ok ? null : response.error.category ?? null, updated_at: new Date() })
          .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
          .where("job_id", "=", job.job_id).where("attempt", "=", job.attempts).execute();
        if (execution_id) {
          const attempt: ProviderAttempt = { job_id: job.job_id, attempt: job.attempts,
            status: response.ok ? "completed" : "failed", ...policy, request_id,
            cost, estimated_cost: job.estimated_cost,
            ...(overage > 0 ? { cost_overage: overage } : {}) };
          await trx.updateTable("observation.evaluation_execution")
            .set({ provider_attempts: sql<JsonText<JsonValue>>`(
              SELECT COALESCE(jsonb_agg(entry ORDER BY ordinality), '[]'::jsonb)
              FROM jsonb_array_elements(provider_attempts) WITH ORDINALITY AS t(entry, ordinality)
              WHERE NOT (entry->>'job_id' = ${job.job_id}
                AND (entry->>'attempt')::int = ${job.attempts}
                AND entry->>'status' = 'dispatched')
            ) || ${jsonText([attempt])}::jsonb` })
            .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
            .where("execution_id", "=", execution_id).execute();
        }
      });
    }
    return response;
  } };
  const result = await runGrade(db, tenant, { identity: intended, reviewed_commit: job.reviewed_commit ?? undefined,
    runner: guarded, lease: { job_id: job.job_id, owner, attempt: job.attempts } });
  if (!result.ok && result.error.outcome === "lost_lease")
    return { kind: "lost_lease", job_id: job.job_id, attempt: job.attempts };
  if (result.ok && isNetwork) await withTenant(db, tenant, (trx) => trx.updateTable("observation.grading_provider_attempt")
    .set({ outcome: result.value.execution.status === "completed" ? "completed" : "failed",
      updated_at: new Date() })
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("job_id", "=", job.job_id).where("attempt", "=", job.attempts)
    .where("outcome", "is", null).where("request_sent", "=", false).execute());
  if (!result.ok && result.error.outcome !== "lost_lease") {
    await withTenant(db, tenant, async (trx) => {
      const ended = await trx.updateTable("observation.grading_job")
        .set({ state: "terminal", terminal_cause: "runner_failed", lease_owner: null,
          lease_expires_at: null, updated_at: new Date() })
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("job_id", "=", job.job_id).where("state", "=", "claimed")
        .where("lease_owner", "=", owner).where("attempts", "=", job.attempts).returning("job_id").executeTakeFirst();
      if (ended) await trx.updateTable("observation.evaluation_execution")
        .set({ status: "failed", ended_at: new Date(), error: result.error.detail })
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("idempotency_digest", "=", job.idempotency_digest).where("status", "=", "running").execute();
      if (ended && isNetwork) await trx.updateTable("observation.grading_provider_attempt")
        .set({ outcome: "failed", updated_at: new Date() })
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("job_id", "=", job.job_id).where("attempt", "=", job.attempts)
        .where("outcome", "is", null).execute();
    });
  }
  return { kind: "processed", job };
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
