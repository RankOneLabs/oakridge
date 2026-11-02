import { randomUUID } from "node:crypto";
import { sql, type Selectable } from "kysely";
import { runGradeDigest, type EvaluationIdentity } from "../grading/execution";
import { runnerEntry } from "../grading/runner";
import { budgetExceeded, type GradingLimits } from "../grading/jobs/budget";
import { jsonText, withTenant, type Database, type TenantScope } from "./database";
import type { ObservationGradingJob } from "./db-types";

export type GradingJob = Selectable<ObservationGradingJob>;
export interface EnqueueInput { readonly identity: EvaluationIdentity; readonly runner_name: string;
  readonly reviewed_commit?: string; readonly estimated_cost?: number }
export async function enqueueJob(db: Database, tenant: TenantScope, input: EnqueueInput, limits: GradingLimits): Promise<GradingJob> {
  if (runnerEntry(input.runner_name)?.network
    && (!input.estimated_cost || input.estimated_cost <= 0))
    throw new Error("network grading requires a positive estimated_cost for budget enforcement");
  const digest = runGradeDigest(input.identity, input.reviewed_commit);
  if (!digest.ok) throw new Error(digest.error.detail);
  return withTenant(db, tenant, async (trx) => {
    const item = await trx.selectFrom("observation.item_occurrence as i")
      .innerJoin("observation.source_revision as r", (join) => join
        .onRef("r.revision_id", "=", "i.revision_id")
        .onRef("r.producer", "=", "i.producer").onRef("r.namespace", "=", "i.namespace"))
      .select(["i.run_id", "r.unit_id"]).where("i.producer", "=", tenant.producer)
      .where("i.namespace", "=", tenant.namespace)
      .where("i.occurrence_id", "=", input.identity.subject_occurrence_id).executeTakeFirstOrThrow();
    const inserted = await trx.insertInto("observation.grading_job").values({ producer: tenant.producer,
      namespace: tenant.namespace, ...input.identity,
      job_id: randomUUID(), idempotency_digest: digest.value, reviewed_commit: input.reviewed_commit ?? null,
      runner_name: input.runner_name, run_id: item.run_id, stage_id: item.unit_id,
      state: "queued", lease_owner: null, lease_expires_at: null, attempts: 0,
      retry_limit: limits.retry_limit, terminal_cause: null, estimated_cost: input.estimated_cost ?? 0,
      disclosure: null })
      .onConflict((conflict) => conflict.columns(["producer", "namespace", "idempotency_digest"]).doNothing())
      .returningAll().executeTakeFirst();
    return inserted ?? trx.selectFrom("observation.grading_job").selectAll()
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("idempotency_digest", "=", digest.value).executeTakeFirstOrThrow();
  });
}
export async function claimJob(db: Database, tenant: TenantScope, owner: string, limits: GradingLimits): Promise<GradingJob | null> {
  return withTenant(db, tenant, async (trx) => {
    const job = await trx.selectFrom("observation.grading_job").selectAll()
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where((eb) => eb.or([eb("state", "in", ["queued", "reclaimable"]),
        eb.and([eb("state", "=", "claimed"), eb("lease_expires_at", "<", new Date())])]))
      .orderBy("created_at").limit(1).forUpdate().skipLocked().executeTakeFirst();
    if (!job) return null;
    if (job.attempts >= job.retry_limit) {
      await trx.updateTable("observation.evaluation_execution")
        .set({ status: "failed", ended_at: new Date(), error: "retry_exhausted" })
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("idempotency_digest", "=", job.idempotency_digest).where("status", "=", "running").execute();
      return trx.updateTable("observation.grading_job")
        .set({ state: "terminal", terminal_cause: "retry_exhausted", lease_owner: null, lease_expires_at: null,
          updated_at: new Date() }).where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("job_id", "=", job.job_id).returningAll().executeTakeFirstOrThrow();
    }
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenant.producer}:${tenant.namespace}:${job.run_id}:grading`}, 0))`.execute(trx);
    const active = await trx.selectFrom("observation.grading_job").selectAll()
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("state", "=", "claimed").where("lease_expires_at", ">", new Date()).execute();
    const completed = await trx.selectFrom("observation.evaluation_execution as e")
      .innerJoin("observation.item_occurrence as i", (join) => join
        .onRef("i.occurrence_id", "=", "e.subject_occurrence_id")
        .onRef("i.producer", "=", "e.producer").onRef("i.namespace", "=", "e.namespace"))
      .innerJoin("observation.source_revision as r", (join) => join
        .onRef("r.revision_id", "=", "i.revision_id")
        .onRef("r.producer", "=", "i.producer").onRef("r.namespace", "=", "i.namespace"))
      .select(["e.cost", "e.provider_attempts", "r.unit_id"]).where("e.producer", "=", tenant.producer)
      .where("e.namespace", "=", tenant.namespace).where("i.run_id", "=", job.run_id)
      .execute();
    // A dispatched attempt is a call in flight or interrupted. While its job still holds a live
    // lease the reservation already accounts for it, so counting it here too would charge one
    // call twice; once the lease lapses the reservation is gone and the dispatched record is the
    // only thing standing between an interrupted paid call and a second admission against zero.
    const leased = new Set(active.map((row) => row.job_id));
    const counts = (attempt: Record<string, unknown>): boolean =>
      attempt.status !== "dispatched" || !leased.has(String(attempt.job_id));
    const spent = (row: typeof completed[number]): number => Array.isArray(row.provider_attempts) && row.provider_attempts.length > 0
      ? row.provider_attempts.reduce<number>((sum, attempt) => sum + (
        attempt && typeof attempt === "object" && !Array.isArray(attempt) && "cost" in attempt
          && typeof attempt.cost === "number" && counts(attempt as Record<string, unknown>) ? attempt.cost : 0), 0)
      : row.cost ?? 0;
    const spend = completed.reduce((sum, row) => sum + spent(row), 0);
    const stage_spend = completed.filter((row) => row.unit_id === job.stage_id)
      .reduce((sum, row) => sum + spent(row), 0);
    const run_active = active.filter((row) => row.run_id === job.run_id);
    const stage_active = run_active.filter((row) => row.stage_id === job.stage_id);
    const exceeded = budgetExceeded({ run_claimed: run_active.length, stage_claimed: stage_active.length,
      run_spend: spend, stage_spend,
      run_reserved: run_active.reduce((sum, row) => sum + row.estimated_cost, 0),
      stage_reserved: stage_active.reduce((sum, row) => sum + row.estimated_cost, 0) },
    job.estimated_cost, limits);
    if (exceeded) {
      if (job.attempts > 0) await trx.updateTable("observation.evaluation_execution")
        .set({ status: "failed", ended_at: new Date(), error: "budget_exceeded" })
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("idempotency_digest", "=", job.idempotency_digest).where("status", "=", "running").execute();
      const skipped = await trx.updateTable("observation.grading_job").set({ state: job.attempts > 0 ? "terminal" : "skipped_budget",
        terminal_cause: "budget_exceeded", lease_owner: null, lease_expires_at: null, updated_at: new Date() })
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("job_id", "=", job.job_id).returningAll().executeTakeFirstOrThrow();
      await trx.insertInto("observation.evaluation_eligibility").values({ producer: tenant.producer,
        namespace: tenant.namespace,
        subject_occurrence_id: job.subject_occurrence_id, question_id: job.question_id,
        question_version: job.question_version, tag: "skipped_budget",
        payload: jsonText({ kind: "skipped_budget", detail: "grading cap exceeded" }) })
        .onConflict((conflict) => conflict.doNothing()).execute();
      return skipped;
    }
    return trx.updateTable("observation.grading_job").set({ state: "claimed", lease_owner: owner,
      lease_expires_at: new Date(Date.now() + limits.lease_ms), attempts: job.attempts + 1,
      updated_at: new Date() }).where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("job_id", "=", job.job_id).returningAll().executeTakeFirstOrThrow();
  });
}
export async function readJob(db: Database, tenant: TenantScope, job_id: string): Promise<GradingJob | undefined> {
  return withTenant(db, tenant, (trx) => trx.selectFrom("observation.grading_job").selectAll()
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("job_id", "=", job_id).executeTakeFirst());
}
export async function listJobs(db: Database, tenant: TenantScope, occurrence_id: string): Promise<GradingJob[]> {
  return withTenant(db, tenant, (trx) => trx.selectFrom("observation.grading_job").selectAll()
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("subject_occurrence_id", "=", occurrence_id).orderBy("created_at", "desc").execute());
}
