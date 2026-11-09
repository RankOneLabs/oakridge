import { sql, type Selectable, type UpdateObject } from "kysely";
import type { EvaluatorDefinitionId, EvidenceSetId, ExecutionId, GradeObservationId, ItemOccurrenceId, QuestionId } from "../domain/identity";
import { err, ok, type JsonValue, type Result } from "../domain/primitives";
import { estimatedCostPerCall, fitsRunAllowance } from "../grading/budget";
import type { EvaluatorDefinition } from "../grading/evaluator";
import type { EvidenceReference, EvidenceSet, ReadyEvidence } from "../grading/evidence";
import { AUTOMATIC_ATTEMPT_LABEL, automaticIdentity, evaluationDigest, failureDisposition, measurementState, type AdmissionCandidate,
  type AttemptFailure, type ClaimResult, type ExecutionClaim, type ExecutionStatus, type ExecutionTerminalCause, type MeasurementState,
  type RunAdmission, type SettlementResult } from "../grading/execution";
import { observationIdOf, type GradeAnswer } from "../grading/observation";
import type { RunConfigWire } from "../ingest/cursor";
import type { QuestionDefinition } from "../grading/question";
import type { EvaluationOutcome } from "../grading/runner";
import { evidenceSetFromRow } from "./captured-evidence-store";
import { jsonText, withTenant, type Database, type DatabaseTransaction, type TenantScope } from "./database";
import type { DB, ObservationEvaluationExecution, ObservationEvaluatorDefinition } from "./db-types";
import { questionFromRow } from "./grading-store";
import { isRunGradingEnabled, readCapturedRunConfig, runGradingEnabled } from "./run-capture-store";

/**
 * evaluation_execution is the one queue, lease and retry record; grading_provider_attempt holds one
 * row per claim and says whether that claim sent a real request. Claims and settlements are short
 * transactions: no transaction is open while a provider is called.
 */
export interface ExecutionStoreError { readonly operation: string; readonly entity_id: string; readonly detail: string }
const storeError = (operation: string, entity_id: string, detail: string): Result<never, ExecutionStoreError> =>
  err({ operation, entity_id, detail });

// ------------------------------------------------------------------ admission ---

interface CandidateRow {
  readonly run_id: string; readonly evidence_set_id: string; readonly subject_occurrence_id: string; readonly question_id: string;
  readonly question_version: string; readonly evaluator_definition_id: string; readonly cost_metadata: JsonValue | null;
}
/** Ready questions of one run, crossed with each pinned machine evaluator still lacking its execution. */
async function admissionCandidates(trx: DatabaseTransaction, tenant: TenantScope, run_id: string): Promise<readonly CandidateRow[]> {
  const rows = await sql<CandidateRow>`
    SELECT i.run_id, e.evidence_set_id, e.subject_occurrence_id, e.question_id, e.question_version, d.evaluator_definition_id, d.cost_metadata
    FROM observation.evidence_set e
    JOIN observation.item_occurrence i ON i.producer = e.producer AND i.namespace = e.namespace AND i.occurrence_id = e.subject_occurrence_id
    JOIN observation.evaluator_definition d ON d.producer = e.producer AND d.namespace = e.namespace
      AND d.evaluator_definition_id = ANY (e.pinned_evaluator_definition_ids)
    WHERE e.producer = ${tenant.producer} AND e.namespace = ${tenant.namespace} AND i.run_id = ${run_id}
      AND e.readiness = 'ready' AND d.kind <> 'human'
      AND NOT EXISTS (SELECT 1 FROM observation.evaluation_execution x WHERE x.producer = e.producer AND x.namespace = e.namespace
        AND x.evidence_set_id = e.evidence_set_id AND x.evaluator_definition_id = d.evaluator_definition_id
        AND x.attempt_label = ${AUTOMATIC_ATTEMPT_LABEL})
    ORDER BY e.created_at, e.evidence_set_id, d.evaluator_definition_id`.execute(trx);
  return rows.rows;
}

/** Runs whose grading is on and which hold ready evidence some pinned machine evaluator has not been admitted for. */
export async function readRunsAwaitingAdmission(db: Database, tenant: TenantScope): Promise<readonly string[]> {
  return withTenant(db, tenant, async (trx) => (await sql<{ run_id: string }>`
    SELECT DISTINCT i.run_id FROM observation.evidence_set e
    JOIN observation.item_occurrence i ON i.producer = e.producer AND i.namespace = e.namespace AND i.occurrence_id = e.subject_occurrence_id
    JOIN observation.evaluator_definition d ON d.producer = e.producer AND d.namespace = e.namespace
      AND d.evaluator_definition_id = ANY (e.pinned_evaluator_definition_ids)
    WHERE e.producer = ${tenant.producer} AND e.namespace = ${tenant.namespace} AND e.readiness = 'ready' AND d.kind <> 'human'
      AND ${runGradingEnabled}
      AND NOT EXISTS (SELECT 1 FROM observation.evaluation_execution x WHERE x.producer = e.producer AND x.namespace = e.namespace
        AND x.evidence_set_id = e.evidence_set_id AND x.evaluator_definition_id = d.evaluator_definition_id
        AND x.attempt_label = ${AUTOMATIC_ATTEMPT_LABEL})
    ORDER BY i.run_id`.execute(trx)).rows.map((row) => row.run_id));
}

export interface AdmissionControls { readonly retry_limit: number }
/**
 * Admits each ready question of an enabled run once for every machine evaluator pinned at capture.
 * The idempotency digest is the measurement identity, so replay, restart or a concurrent pass adds
 * nothing. Current configuration plays no part: the pinned definition supplies runner and estimate.
 */
export async function admitRun(db: Database, tenant: TenantScope, run_id: string, controls: AdmissionControls)
  : Promise<Result<RunAdmission, ExecutionStoreError>> {
  try {
    return await withTenant(db, tenant, async (trx) => {
      if (!await isRunGradingEnabled(trx, tenant, run_id)) return ok({ kind: "grading_off", run_id });
      const admitted: ExecutionId[] = [];
      let already_admitted = 0;
      for (const row of await admissionCandidates(trx, tenant, run_id)) {
        const estimated_cost = estimatedCostPerCall(row.cost_metadata);
        if (estimated_cost === null) throw new Error(`evaluator ${row.evaluator_definition_id} carries no estimated cost per call`);
        const candidate: AdmissionCandidate = { run_id: row.run_id, subject_occurrence_id: row.subject_occurrence_id as ItemOccurrenceId,
          evidence_set_id: row.evidence_set_id as EvidenceSetId, question_id: row.question_id as QuestionId,
          question_version: row.question_version, evaluator_definition_id: row.evaluator_definition_id as EvaluatorDefinitionId, estimated_cost };
        const identity = automaticIdentity(candidate);
        const digest = evaluationDigest(identity);
        if (!digest.ok) throw new Error(digest.error.detail);
        const inserted = await trx.insertInto("observation.evaluation_execution").values({ producer: tenant.producer, namespace: tenant.namespace,
          execution_id: digest.value, run_id: candidate.run_id, ...identity, idempotency_digest: digest.value, status: "queued",
          retry_limit: controls.retry_limit, estimated_cost })
          .onConflict((conflict) => conflict.columns(["producer", "namespace", "idempotency_digest"]).doNothing())
          .returning("execution_id").executeTakeFirst();
        if (inserted) admitted.push(inserted.execution_id as ExecutionId); else already_admitted++;
      }
      return ok({ kind: "admitted", run_id, admitted, already_admitted });
    });
  } catch (cause) { return storeError("admit_run", run_id, cause instanceof Error ? cause.message : String(cause)); }
}

// ---------------------------------------------------------------------- claim ---

export interface ClaimControls {
  readonly lease_owner: string;
  readonly lease_ms: number;
  /** The run allowance, in configured estimates. */
  readonly run_spend: number;
}

/** What a run has spent or holds in reservation: each sent request at its configured estimate, and
 * each open claim that has not sent one yet. A claim that ended unsent counts nothing. */
async function runCommittedSpend(trx: DatabaseTransaction, tenant: TenantScope, run_id: string): Promise<number> {
  const row = await sql<{ committed: number }>`SELECT coalesce(sum(CASE WHEN request_sent THEN charged_cost
      WHEN outcome IS NULL THEN admitted_estimate ELSE 0 END), 0)::double precision AS committed
    FROM observation.grading_provider_attempt
    WHERE producer = ${tenant.producer} AND namespace = ${tenant.namespace} AND run_id = ${run_id}`.execute(trx);
  return Number(row.rows[0]?.committed ?? 0);
}
/** Every claim against one run's allowance takes this lock first, so two workers cannot both spend
 * the same remainder. */
async function lockRunAllowance(trx: DatabaseTransaction, tenant: TenantScope, run_id: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenant.producer}:${tenant.namespace}:${run_id}:grading-allowance`}, 0))`.execute(trx);
}
/** A reservation that ended without a request frees allowance, so the run's deferred work may fit again. */
async function requeueDeferred(trx: DatabaseTransaction, tenant: TenantScope, run_id: string): Promise<void> {
  await trx.updateTable("observation.evaluation_execution").set({ status: "queued", updated_at: sql<Date>`clock_timestamp()` })
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace).where("run_id", "=", run_id)
    .where("status", "=", "budget_deferred").execute();
}
/** At startup the allowance may have changed: deferred work is offered again and re-deferred if it still cannot fit. */
export async function requeueAllDeferred(db: Database, tenant: TenantScope): Promise<number> {
  return withTenant(db, tenant, async (trx) => Number((await trx.updateTable("observation.evaluation_execution")
    .set({ status: "queued", updated_at: sql<Date>`clock_timestamp()` }).where("producer", "=", tenant.producer)
    .where("namespace", "=", tenant.namespace).where("status", "=", "budget_deferred").executeTakeFirst()).numUpdatedRows));
}

const ended = (status: "failed", error: string, terminal_cause: ExecutionTerminalCause) => ({ status, error, terminal_cause,
  lease_owner: null, lease_expires_at: null, ended_at: sql<Date>`clock_timestamp()`, updated_at: sql<Date>`clock_timestamp()` });

/**
 * Claims the oldest due execution: queued, reclaimable, or claimed under a lease that has expired.
 * Reclaiming closes the earlier claim's attempt; if that claim had sent a request, the request stays
 * charged and counts as a retry. The next request is reserved against the run allowance in the same
 * transaction, or the execution is deferred and no request is made.
 */
export async function claimNext(db: Database, tenant: TenantScope, controls: ClaimControls): Promise<ClaimResult> {
  return withTenant(db, tenant, async (trx) => {
    const due = await trx.selectFrom("observation.evaluation_execution")
      .select(["execution_id", "run_id", "status", "attempts", "retries", "retry_limit", "estimated_cost"])
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where((eb) => eb.or([eb("status", "in", ["queued", "reclaimable"]),
        eb.and([eb("status", "=", "claimed"), eb("lease_expires_at", "<=", sql<Date>`clock_timestamp()`)])]))
      .orderBy("updated_at").orderBy("execution_id").limit(1).forUpdate().skipLocked().executeTakeFirst();
    if (!due) return { kind: "idle" };
    const execution_id = due.execution_id as ExecutionId;
    await lockRunAllowance(trx, tenant, due.run_id);
    let retries = due.retries;
    const open = due.attempts > 0 ? await trx.updateTable("observation.grading_provider_attempt")
      .set({ outcome: "failed", failure_category: "lease_expired", updated_at: sql<Date>`clock_timestamp()` })
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace).where("execution_id", "=", execution_id)
      .where("attempt", "=", due.attempts).where("outcome", "is", null).returning("request_sent").executeTakeFirst() : undefined;
    if (open?.request_sent) {
      const disposition = failureDisposition("lease_expired", due);
      if (disposition.kind === "fail") {
        await trx.updateTable("observation.evaluation_execution")
          .set(ended("failed", "lease_expired: a claim that sent a request expired and no retry remains", disposition.terminal_cause))
          .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace).where("execution_id", "=", execution_id).execute();
        return { kind: "retry_exhausted", execution_id, run_id: due.run_id };
      }
      retries = disposition.retries;
    }
    const committed = await runCommittedSpend(trx, tenant, due.run_id);
    if (!fitsRunAllowance({ committed, estimate: due.estimated_cost, allowance: controls.run_spend })) {
      await trx.updateTable("observation.evaluation_execution").set({ status: "budget_deferred", retries, lease_owner: null,
        lease_expires_at: null, updated_at: sql<Date>`clock_timestamp()` })
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace).where("execution_id", "=", execution_id).execute();
      return { kind: "budget_deferred", execution_id, run_id: due.run_id };
    }
    const claimed = await trx.updateTable("observation.evaluation_execution").set({ status: "claimed", retries,
      lease_owner: controls.lease_owner, attempts: sql<number>`attempts + 1`,
      lease_expires_at: sql<Date>`clock_timestamp() + ${controls.lease_ms} * interval '1 millisecond'`,
      started_at: sql<Date>`coalesce(started_at, clock_timestamp())`, updated_at: sql<Date>`clock_timestamp()` })
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace).where("execution_id", "=", execution_id)
      .returning(["attempts", "lease_expires_at"]).executeTakeFirstOrThrow();
    await trx.insertInto("observation.grading_provider_attempt").values({ producer: tenant.producer, namespace: tenant.namespace,
      execution_id, attempt: claimed.attempts, run_id: due.run_id, admitted_estimate: due.estimated_cost }).execute();
    if (open && !open.request_sent) await requeueDeferred(trx, tenant, due.run_id);
    return { kind: "claimed", claim: { execution_id, run_id: due.run_id, lease_owner: controls.lease_owner,
      claim_attempt: claimed.attempts, lease_expires_at: claimed.lease_expires_at! } };
  });
}

// ------------------------------------------------------------- fenced writes ---

/** The exact claim, as a predicate on its execution row: same owner, same claim attempt, and a lease
 * still unexpired by database time when the predicate runs. */
const isCurrentClaim = (claim: ExecutionClaim) => sql<boolean>`status = 'claimed' AND lease_owner = ${claim.lease_owner}
  AND attempts = ${claim.claim_attempt} AND lease_expires_at > clock_timestamp()`;

/** Rolls a settlement back when its claim stopped being current between the check and the write. */
class StaleClaim extends Error {}

/**
 * Locks the execution row, then reads it only if this exact claim is current. The lock comes first
 * and carries no lease predicate: a predicate PostgreSQL evaluated before waiting on another
 * transaction's lock is not re-evaluated once the lock is granted, so a claim that expired during
 * the wait would pass. Every check after the lock reads the clock afresh.
 */
async function fenced(trx: DatabaseTransaction, tenant: TenantScope, claim: ExecutionClaim)
  : Promise<Selectable<ObservationEvaluationExecution> | undefined> {
  const locked = await trx.selectFrom("observation.evaluation_execution").select("execution_id")
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace).where("execution_id", "=", claim.execution_id)
    .forUpdate().executeTakeFirst();
  if (!locked) return undefined;
  return trx.selectFrom("observation.evaluation_execution").selectAll()
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace).where("execution_id", "=", claim.execution_id)
    .where(isCurrentClaim(claim)).executeTakeFirst();
}

/** The authoritative settlement write, fenced again at the moment it is made. */
async function settleExecution(trx: DatabaseTransaction, tenant: TenantScope, claim: ExecutionClaim,
  values: UpdateObject<DB, "observation.evaluation_execution">): Promise<void> {
  const updated = await trx.updateTable("observation.evaluation_execution").set(values)
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace).where("execution_id", "=", claim.execution_id)
    .where(isCurrentClaim(claim)).executeTakeFirst();
  if (updated.numUpdatedRows !== 1n) throw new StaleClaim();
}

/** Records, before it is made, that this claim is sending its request; the request is then charged
 * at its configured estimate. False means the claim is no longer current and nothing may be sent. */
export async function markRequestSent(db: Database, tenant: TenantScope, claim: ExecutionClaim): Promise<boolean> {
  return withTenant(db, tenant, async (trx) => {
    if (!await fenced(trx, tenant, claim)) return false;
    // The mark itself is fenced too: it writes only while the execution still holds this claim.
    const marked = await trx.updateTable("observation.grading_provider_attempt")
      .set({ request_sent: true, charged_cost: sql<number>`admitted_estimate`, updated_at: sql<Date>`clock_timestamp()` })
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace).where("execution_id", "=", claim.execution_id)
      .where("attempt", "=", claim.claim_attempt).where("outcome", "is", null).where("request_sent", "=", false)
      .where(sql<boolean>`EXISTS (SELECT 1 FROM observation.evaluation_execution x WHERE x.producer = ${tenant.producer}
        AND x.namespace = ${tenant.namespace} AND x.execution_id = ${claim.execution_id} AND x.status = 'claimed'
        AND x.lease_owner = ${claim.lease_owner} AND x.attempts = ${claim.claim_attempt} AND x.lease_expires_at > clock_timestamp())`)
      .returning("attempt").executeTakeFirst();
    return marked !== undefined;
  });
}

/** Runs a settlement; a claim found stale at any fenced point leaves nothing written. */
async function settlement(db: Database, tenant: TenantScope, claim: ExecutionClaim,
  work: (trx: DatabaseTransaction) => Promise<SettlementResult>): Promise<SettlementResult> {
  try { return await withTenant(db, tenant, work); }
  catch (cause) {
    if (cause instanceof StaleClaim) return { kind: "stale_claim", execution_id: claim.execution_id };
    throw cause;
  }
}

const overage = (provider_cost: number | null | undefined) =>
  provider_cost === null || provider_cost === undefined ? sql<number>`0`
    : sql<number>`greatest(0, ${provider_cost}::double precision - admitted_estimate)`;

/** Completes the execution and appends its answer in one transaction: both commit or neither does. */
export async function completeExecution(db: Database, tenant: TenantScope, claim: ExecutionClaim, outcome: EvaluationOutcome)
  : Promise<Result<SettlementResult, ExecutionStoreError>> {
  try {
    return ok(await settlement(db, tenant, claim, async (trx): Promise<SettlementResult> => {
      if (!await fenced(trx, tenant, claim)) return { kind: "stale_claim", execution_id: claim.execution_id };
      await settleExecution(trx, tenant, claim, { status: "completed", lease_owner: null, lease_expires_at: null,
        ended_at: sql<Date>`clock_timestamp()`, updated_at: sql<Date>`clock_timestamp()`,
        model_usage: outcome.model_usage === undefined || outcome.model_usage === null ? null : jsonText(outcome.model_usage),
        cost: outcome.cost ?? null, external_execution_id: outcome.external_execution_id ?? null, provider_link: outcome.provider_link ?? null,
        reproducibility_metadata: outcome.reproducibility_metadata === undefined || outcome.reproducibility_metadata === null
          ? null : jsonText(outcome.reproducibility_metadata) });
      await trx.updateTable("observation.grading_provider_attempt").set({ outcome: "completed", updated_at: sql<Date>`clock_timestamp()`,
        provider_request_id: outcome.external_execution_id ?? null, cost_overage: overage(outcome.cost) })
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace).where("execution_id", "=", claim.execution_id)
        .where("attempt", "=", claim.claim_attempt).execute();
      const observation_id = observationIdOf(claim.execution_id);
      await trx.insertInto("observation.grade_observation").values({ producer: tenant.producer, namespace: tenant.namespace, observation_id,
        execution_id: claim.execution_id, answer_kind: outcome.answer.kind, answer_state: outcome.answer.state,
        answer_payload: jsonText(outcome.answer as unknown as JsonValue),
        probabilities: outcome.probabilities ? jsonText(outcome.probabilities as unknown as JsonValue) : null,
        confidence: outcome.confidence ?? null, reviewer_id: null, reviewer_details: null, comments: outcome.comments ?? null,
        rationale: outcome.rationale ?? null, quality_flags: jsonText([...(outcome.quality_flags ?? [])]) }).execute();
      return { kind: "completed", execution_id: claim.execution_id, observation_id };
    }));
  } catch (cause) { return storeError("complete_execution", claim.execution_id, cause instanceof Error ? cause.message : String(cause)); }
}

/** Records a failed attempt and applies the execution's persisted retry policy. Exhaustion ends the
 * execution failed, and no answer is ever written for it. */
export async function failExecution(db: Database, tenant: TenantScope, claim: ExecutionClaim, failure: AttemptFailure)
  : Promise<Result<SettlementResult, ExecutionStoreError>> {
  try {
    return ok(await settlement(db, tenant, claim, async (trx): Promise<SettlementResult> => {
      const current = await fenced(trx, tenant, claim);
      if (!current) return { kind: "stale_claim", execution_id: claim.execution_id };
      // An unsent attempt releases its reservation and wakes the run's deferred work. Both happen under
      // the run's allowance lock, so a claim deciding meanwhile waits and then sees the release, and
      // cannot commit a deferral after the wake-up has looked.
      await lockRunAllowance(trx, tenant, claim.run_id);
      const disposition = failureDisposition(failure.category, current);
      if (disposition.kind === "retry") await settleExecution(trx, tenant, claim, { status: "queued", retries: disposition.retries,
        lease_owner: null, lease_expires_at: null, updated_at: sql<Date>`clock_timestamp()` });
      else await settleExecution(trx, tenant, claim, ended("failed", `${failure.category}: ${failure.detail}`, disposition.terminal_cause));
      const attempt = await trx.updateTable("observation.grading_provider_attempt").set({ outcome: "failed", updated_at: sql<Date>`clock_timestamp()`,
        failure_category: failure.category, provider_request_id: failure.provider_request_id, cost_overage: overage(failure.provider_cost) })
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace).where("execution_id", "=", claim.execution_id)
        .where("attempt", "=", claim.claim_attempt).returning("request_sent").executeTakeFirstOrThrow();
      if (!attempt.request_sent) await requeueDeferred(trx, tenant, claim.run_id);
      return disposition.kind === "retry" ? { kind: "retry_queued", execution_id: claim.execution_id, retries: disposition.retries }
        : { kind: "failed", execution_id: claim.execution_id, terminal_cause: disposition.terminal_cause };
    }));
  } catch (cause) { return storeError("fail_execution", claim.execution_id, cause instanceof Error ? cause.message : String(cause)); }
}

// ---------------------------------------------------------------------- reads ---

export function evaluatorFromRow(row: Selectable<ObservationEvaluatorDefinition>): EvaluatorDefinition {
  return { evaluator_definition_id: row.evaluator_definition_id, kind: row.kind as EvaluatorDefinition["kind"], backend_kind: row.backend_kind,
    provider: row.provider, model: row.model, prompt_digest: row.prompt_digest, instruction_text: row.instruction_text ?? "",
    config_digest: row.config_digest, runtime_revision: row.runtime_revision, cost_metadata: row.cost_metadata, seed: row.seed,
    attempt_controls: row.attempt_controls };
}

/** What a claimed execution is measured with: its pinned question, its pinned evaluator and its frozen evidence. */
export interface ExecutionContext {
  readonly question: QuestionDefinition;
  readonly evaluator: EvaluatorDefinition;
  readonly evidence: ReadyEvidence;
}
export async function readExecutionContext(db: Database, tenant: TenantScope, execution_id: ExecutionId)
  : Promise<Result<ExecutionContext, ExecutionStoreError>> {
  return withTenant(db, tenant, async (trx) => {
    const execution = await trx.selectFrom("observation.evaluation_execution").selectAll().where("producer", "=", tenant.producer)
      .where("namespace", "=", tenant.namespace).where("execution_id", "=", execution_id).executeTakeFirst();
    if (!execution) return storeError("read_execution_context", execution_id, "execution not found");
    const question = await trx.selectFrom("observation.question_definition").selectAll().where("producer", "=", tenant.producer)
      .where("namespace", "=", tenant.namespace).where("question_id", "=", execution.question_id)
      .where("question_version", "=", execution.question_version).executeTakeFirstOrThrow();
    const evaluator = await trx.selectFrom("observation.evaluator_definition").selectAll().where("producer", "=", tenant.producer)
      .where("namespace", "=", tenant.namespace).where("evaluator_definition_id", "=", execution.evaluator_definition_id).executeTakeFirstOrThrow();
    const evidence = await trx.selectFrom("observation.evidence_set").selectAll().where("producer", "=", tenant.producer)
      .where("namespace", "=", tenant.namespace).where("evidence_set_id", "=", execution.evidence_set_id).executeTakeFirstOrThrow();
    if (evidence.readiness !== "ready") return storeError("read_execution_context", execution_id, "evidence is not ready");
    return ok({ question: questionFromRow(question), evaluator: evaluatorFromRow(evaluator),
      evidence: { evidence_set_id: evidence.evidence_set_id as EvidenceSetId, references: evidence.evidence_refs as unknown as readonly EvidenceReference[],
        is_incomplete: evidence.is_incomplete, incompleteness_reason: evidence.incompleteness_reason } });
  });
}

/** One real or reserved request, as its attempt row records it. */
export interface AttemptRead {
  readonly attempt: number;
  readonly request_sent: boolean;
  readonly outcome: "completed" | "failed" | null;
  readonly failure_category: string | null;
  readonly charged_cost: number;
  readonly admitted_estimate: number;
  readonly provider_request_id: string | null;
}
export interface EvaluatorMeasurement {
  readonly evaluator_definition_id: EvaluatorDefinitionId;
  readonly backend_kind: string;
  readonly model: string | null;
  readonly execution_id: ExecutionId | null;
  readonly measurement: MeasurementState;
  readonly attempts: readonly AttemptRead[];
}
/** One pinned question of an item: its evidence readiness, whether a reviewer can answer it now, and
 * each pinned machine evaluator's distinct status. */
export interface QuestionMeasurements {
  readonly evidence: EvidenceSet;
  readonly is_human_ready: boolean;
  readonly machine: readonly EvaluatorMeasurement[];
}
export interface ItemMeasurements {
  readonly occurrence_id: ItemOccurrenceId;
  readonly run_id: string;
  readonly is_grading_enabled: boolean;
  readonly questions: readonly QuestionMeasurements[];
}

export function readItemMeasurements(db: Database, tenant: TenantScope, occurrence_id: string): Promise<ItemMeasurements | null> {
  return withTenant(db, tenant, (trx) => readItemMeasurementsIn(trx, tenant, occurrence_id));
}
/** The same read inside a caller's transaction, so it can share a snapshot. */
export async function readItemMeasurementsIn(trx: DatabaseTransaction, tenant: TenantScope, occurrence_id: string): Promise<ItemMeasurements | null> {
  {
    const item = await trx.selectFrom("observation.item_occurrence").select(["occurrence_id", "run_id"]).where("producer", "=", tenant.producer)
      .where("namespace", "=", tenant.namespace).where("occurrence_id", "=", occurrence_id).executeTakeFirst();
    if (!item) return null;
    const is_grading_enabled = await isRunGradingEnabled(trx, tenant, item.run_id);
    const sets = (await trx.selectFrom("observation.evidence_set").selectAll().where("producer", "=", tenant.producer)
      .where("namespace", "=", tenant.namespace).where("subject_occurrence_id", "=", occurrence_id)
      .orderBy("question_id").orderBy("question_version").execute()).map(evidenceSetFromRow);
    const evaluators = await trx.selectFrom("observation.evaluator_definition").selectAll().where("producer", "=", tenant.producer)
      .where("namespace", "=", tenant.namespace).where("kind", "<>", "human").execute();
    const executions = await trx.selectFrom("observation.evaluation_execution").selectAll().where("producer", "=", tenant.producer)
      .where("namespace", "=", tenant.namespace).where("subject_occurrence_id", "=", occurrence_id)
      .where("attempt_label", "=", AUTOMATIC_ATTEMPT_LABEL).execute();
    const ids = executions.map((execution) => execution.execution_id);
    const observations = ids.length === 0 ? [] : await trx.selectFrom("observation.grade_observation")
      .select(["observation_id", "execution_id", "answer_payload"]).where("producer", "=", tenant.producer)
      .where("namespace", "=", tenant.namespace).where("execution_id", "in", ids).execute();
    const attempts = ids.length === 0 ? [] : await trx.selectFrom("observation.grading_provider_attempt").selectAll()
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace).where("execution_id", "in", ids)
      .orderBy("execution_id").orderBy("attempt").execute();
    const questions = sets.map((evidence): QuestionMeasurements => ({ evidence, is_human_ready: evidence.readiness.state === "ready",
      machine: evaluators.filter((evaluator) => evidence.pinned_evaluator_definition_ids.includes(evaluator.evaluator_definition_id as EvaluatorDefinitionId))
        .map((evaluator) => {
          const execution = executions.find((row) => row.evidence_set_id === evidence.evidence_set_id
            && row.evaluator_definition_id === evaluator.evaluator_definition_id) ?? null;
          const observation = execution ? observations.find((row) => row.execution_id === execution.execution_id) ?? null : null;
          return { evaluator_definition_id: evaluator.evaluator_definition_id as EvaluatorDefinitionId, backend_kind: evaluator.backend_kind,
            model: evaluator.model, execution_id: (execution?.execution_id ?? null) as ExecutionId | null,
            measurement: measurementState({ readiness: evidence.readiness, is_grading_enabled,
              execution: execution ? { status: execution.status as ExecutionStatus, terminal_cause: execution.terminal_cause as ExecutionTerminalCause | null,
                error: execution.error } : null,
              observation: observation ? { observation_id: observation.observation_id as GradeObservationId,
                answer: observation.answer_payload as unknown as GradeAnswer } : null }),
            attempts: attempts.filter((row) => row.execution_id === execution?.execution_id).map((row) => ({ attempt: row.attempt,
              request_sent: row.request_sent, outcome: row.outcome as AttemptRead["outcome"], failure_category: row.failure_category,
              charged_cost: row.charged_cost, admitted_estimate: row.admitted_estimate, provider_request_id: row.provider_request_id })) };
        }) }));
    return { occurrence_id: item.occurrence_id as ItemOccurrenceId, run_id: item.run_id, is_grading_enabled, questions };
  }
}

/** A run's automatic-grading spend: what its claims sent or hold in reservation, against its allowance. */
export interface RunSpend {
  readonly run_id: string;
  /** The choice the run's captured launch committed. */
  readonly is_grading_enabled: boolean;
  /** The exact config the launch delivered, or null when it carried none. */
  readonly captured_config: RunConfigWire | null;
  readonly committed: number;
  readonly requests_sent: number;
  readonly attempts: number;
  readonly executions: Readonly<Record<ExecutionStatus, number>>;
}
export async function readRunSpend(db: Database, tenant: TenantScope, run_id: string): Promise<RunSpend> {
  return withTenant(db, tenant, async (trx) => {
    const committed = await runCommittedSpend(trx, tenant, run_id);
    const counted = await trx.selectFrom("observation.grading_provider_attempt")
      .select([sql<number>`count(*) FILTER (WHERE request_sent)::integer`.as("requests_sent"), sql<number>`count(*)::integer`.as("attempts")])
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace).where("run_id", "=", run_id).executeTakeFirstOrThrow();
    const statuses = await trx.selectFrom("observation.evaluation_execution").select(["status", sql<number>`count(*)::integer`.as("count")])
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace).where("run_id", "=", run_id)
      .groupBy("status").execute();
    const executions: Record<ExecutionStatus, number> = { queued: 0, claimed: 0, reclaimable: 0, budget_deferred: 0, completed: 0, failed: 0 };
    for (const row of statuses) executions[row.status as ExecutionStatus] = Number(row.count);
    return { run_id, is_grading_enabled: await isRunGradingEnabled(trx, tenant, run_id),
      captured_config: await readCapturedRunConfig(trx, tenant, run_id), committed, requests_sent: Number(counted.requests_sent),
      attempts: Number(counted.attempts), executions };
  });
}
