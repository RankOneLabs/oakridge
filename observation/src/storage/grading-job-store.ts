import { randomUUID } from "node:crypto";
import { sql, type Selectable } from "kysely";
import { runGradeDigest, type EvaluationIdentity } from "../grading/execution";
import { networkRunnerNames, runnerEntry, type GradingContext } from "../grading/runner";
import { repositorySnapshotEligibility } from "../grading/eligibility";
import { concurrencyExceeded, spendExceeded, type BudgetUsage, type GradingLimits } from "../grading/jobs/budget";
import { withTenant, type Database, type TenantScope } from "./database";
import type { ObservationGradingJob } from "./db-types";
import { registerGradingContext, validateIdentity } from "./grading-store";

export type GradingJob = Selectable<ObservationGradingJob>;
export interface EnqueueInput { readonly identity: EvaluationIdentity; readonly runner_name: string;
  readonly reviewed_commit?: string; readonly estimated_cost?: number; readonly context?: GradingContext }
export async function enqueueJob(db: Database, tenant: TenantScope, input: EnqueueInput, limits: GradingLimits): Promise<GradingJob> {
  const runner = runnerEntry(input.runner_name);
  if (!runner) throw new Error(`unknown runner ${input.runner_name}`);
  if (input.estimated_cost !== undefined && (!Number.isFinite(input.estimated_cost) || input.estimated_cost < 0))
    throw new Error("estimated_cost must be finite and nonnegative");
  if (runner.network
    && (!input.estimated_cost || input.estimated_cost <= 0))
    throw new Error("network grading requires a positive estimated_cost for budget enforcement");
  if (input.context) {
    const { question, evidence, evaluator } = input.context;
    if (question.question_id !== input.identity.question_id || question.question_version !== input.identity.question_version
      || evidence.evidence_set_id !== input.identity.evidence_set_id
      || evaluator.evaluator_definition_id !== input.identity.evaluator_definition_id
      || evaluator.config_digest !== input.identity.config_digest)
      throw new Error("context and identity differ");
    const registered = await registerGradingContext(db, tenant, input.context);
    if (!registered.ok) throw new Error(registered.error.detail);
  }
  const digest = runGradeDigest(input.identity, input.reviewed_commit);
  if (!digest.ok) throw new Error(digest.error.detail);
  return withTenant(db, tenant, async (trx) => {
    const checked = await validateIdentity(trx, tenant, input.identity);
    if (!checked.ok) throw new Error(checked.error.detail);
    if (checked.value.evaluator.kind !== runner.kind)
      throw new Error("runner kind differs from evaluator definition");
    const { question, evidence } = checked.value;
    if (evidence.is_incomplete && question.missing_evidence_policy === "fail")
      throw new Error(evidence.incompleteness_reason ?? "evidence set is incomplete");
    if (question.requires_repository_snapshot) {
      const snapshot = repositorySnapshotEligibility(evidence,
        Number(question.input_recipe.minimum_repository_content ?? 1), input.reviewed_commit ?? "");
      if (snapshot.tag !== "eligible") throw new Error("repository evidence is not eligible for grading");
    }
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
export type ClaimOutcome = { readonly kind: "admitted"; readonly job: GradingJob }
  | { readonly kind: "deferred"; readonly reason: "concurrency" | "empty" }
  | { readonly kind: "refused"; readonly job: GradingJob; readonly terminal_cause: "budget_exceeded" | "retry_exhausted" };

/** Admission is serialized per run. The SQL sums use indexed attempt columns, never execution JSON. */
export async function claimJob(db: Database, tenant: TenantScope, owner: string, limits: GradingLimits): Promise<ClaimOutcome> {
  return withTenant(db, tenant, async (trx) => {
    let deferred = false;
    const examined: string[] = [];
    while (true) {
      let query = trx.selectFrom("observation.grading_job").selectAll()
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where((eb) => eb.or([eb("state", "in", ["queued", "reclaimable"]),
          eb.and([eb("state", "=", "claimed"), eb("lease_expires_at", "<", new Date())])]))
        .orderBy("created_at").limit(1).forUpdate().skipLocked();
      if (examined.length > 0) query = query.where("job_id", "not in", examined);
      const job = await query.executeTakeFirst();
      if (!job) break;
      examined.push(job.job_id);
      if (job.attempts > job.retry_limit) {
        await trx.updateTable("observation.evaluation_execution")
          .set({ status: "failed", ended_at: new Date(), error: "retry_exhausted" })
          .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
          .where("idempotency_digest", "=", job.idempotency_digest).where("status", "=", "running").execute();
        const ended = await trx.updateTable("observation.grading_job")
          .set({ state: "terminal", terminal_cause: "retry_exhausted", lease_owner: null, lease_expires_at: null,
            updated_at: new Date() }).where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
          .where("job_id", "=", job.job_id).returningAll().executeTakeFirstOrThrow();
        return { kind: "refused", job: ended, terminal_cause: "retry_exhausted" };
      }
      const runLock = await sql<{ locked: boolean }>`SELECT pg_try_advisory_xact_lock(
        hashtextextended(${`${tenant.producer}:${tenant.namespace}:${job.run_id}:grading`}, 0)) AS locked`.execute(trx);
      if (!runLock.rows[0]?.locked) { deferred = true; continue; }
      const active = await trx.selectFrom("observation.grading_job as j")
        .leftJoin("observation.grading_provider_attempt as a", (join) => join
          .onRef("a.producer", "=", "j.producer").onRef("a.namespace", "=", "j.namespace")
          .onRef("a.job_id", "=", "j.job_id").onRef("a.attempt", "=", "j.attempts"))
        .select([
          sql<number>`count(*)::integer`.as("run_claimed"),
          sql<number>`count(*) FILTER (WHERE j.stage_id = ${job.stage_id})::integer`.as("stage_claimed"),
          sql<number>`coalesce(sum(CASE WHEN a.outcome IS NOT NULL THEN a.charged_cost
            ELSE j.estimated_cost END) FILTER (WHERE j.runner_name = ANY(${networkRunnerNames}::text[])), 0)`.as("run_reserved"),
          sql<number>`coalesce(sum(CASE WHEN a.outcome IS NOT NULL THEN a.charged_cost
            ELSE j.estimated_cost END) FILTER (WHERE j.stage_id = ${job.stage_id}
            AND j.runner_name = ANY(${networkRunnerNames}::text[])), 0)`.as("stage_reserved"),
        ])
        .where("j.producer", "=", tenant.producer).where("j.namespace", "=", tenant.namespace)
        .where("j.run_id", "=", job.run_id).where("j.state", "=", "claimed")
        .where("j.lease_expires_at", ">", new Date()).executeTakeFirstOrThrow();
      const spend = await trx.selectFrom("observation.grading_provider_attempt as a")
        .innerJoin("observation.grading_job as j", (join) => join
          .onRef("j.producer", "=", "a.producer").onRef("j.namespace", "=", "a.namespace")
          .onRef("j.job_id", "=", "a.job_id"))
        .select([
          sql<number>`coalesce(sum(CASE WHEN j.state = 'claimed' AND j.lease_expires_at > now()
            AND j.attempts = a.attempt THEN 0 ELSE a.charged_cost END), 0)`.as("run_spend"),
          sql<number>`coalesce(sum(CASE WHEN a.stage_id = ${job.stage_id} THEN
            CASE WHEN j.state = 'claimed' AND j.lease_expires_at > now()
              AND j.attempts = a.attempt THEN 0 ELSE a.charged_cost END ELSE 0 END), 0)`.as("stage_spend"),
        ])
        .where("a.producer", "=", tenant.producer).where("a.namespace", "=", tenant.namespace)
        .where("a.run_id", "=", job.run_id)
        .where("j.runner_name", "in", networkRunnerNames).executeTakeFirstOrThrow();
      const usage: BudgetUsage = { ...active, ...spend };
      if (concurrencyExceeded(usage, limits)) { deferred = true; continue; }
      if (spendExceeded(usage, runnerEntry(job.runner_name)?.network ? job.estimated_cost : 0, limits)) {
        if (job.attempts > 0) await trx.updateTable("observation.evaluation_execution")
          .set({ status: "failed", ended_at: new Date(), error: "budget_exceeded" })
          .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
          .where("idempotency_digest", "=", job.idempotency_digest).where("status", "=", "running").execute();
        const ended = await trx.updateTable("observation.grading_job")
          .set({ state: job.attempts > 0 ? "terminal" : "skipped_budget",
            terminal_cause: "budget_exceeded", lease_owner: null, lease_expires_at: null, updated_at: new Date() })
          .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
          .where("job_id", "=", job.job_id).returningAll().executeTakeFirstOrThrow();
        return { kind: "refused", job: ended, terminal_cause: "budget_exceeded" };
      }
      const claimed = await trx.updateTable("observation.grading_job").set({ state: "claimed", lease_owner: owner,
        lease_expires_at: new Date(Date.now() + limits.lease_ms), attempts: job.attempts + 1,
        updated_at: new Date() }).where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("job_id", "=", job.job_id).returningAll().executeTakeFirstOrThrow();
      return { kind: "admitted", job: claimed };
    }
    return { kind: "deferred", reason: deferred ? "concurrency" : "empty" };
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
