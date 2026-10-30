import { randomUUID } from "node:crypto";
import { sql, type Selectable } from "kysely";
import { canonicalJson } from "../canonical/canonical-json";
import type { JsonValue, Result } from "../domain/primitives";
import { err, ok } from "../domain/primitives";
import type { QuestionDefinition } from "../grading/question";
import type { EvidenceSet } from "../grading/evidence";
import { repositorySnapshotEligibility } from "../grading/eligibility";
import { evaluatorIdentity, instructionDigest, type EvaluatorDefinition } from "../grading/evaluator";
import { evaluationDigest, runGradeDigest, type EvaluationIdentity } from "../grading/execution";
import type { GradeAnswer, GradeListingItem, GradeObservation } from "../grading/observation";
import type { EvaluationOutcome, GradingContext, GradingError, RunnerResult } from "../grading/runner";
import { withTenant, type Database, type DatabaseTransaction, type TenantScope } from "./database";
import type { ObservationEvaluationExecution, ObservationGradeObservation } from "./db-types";
import type { Page } from "./projection-store";
import type { GradeRunner } from "../ports/grade-runner";

export interface GradeDetails extends Omit<GradeObservation, "observation_id"> {
  readonly collection_mode: "blind" | "in_context";
  readonly blind_assignment_id?: string | null;
  readonly model_answers_visible: boolean;
  readonly workflow_decisions_visible: boolean;
}
export interface GradePage extends Page { readonly total: number; readonly items: readonly GradeListingItem[] }

const json = (value: JsonValue) => sql<JsonValue>`${JSON.stringify(value)}::jsonb`;
const scope = (tenant: TenantScope) => ({ producer: tenant.producer, namespace: tenant.namespace });
function failure(operation: string, entity_id: string, detail: string): Result<never, GradingError> {
  return err({ operation, entity_id, detail });
}
function same(left: unknown, right: unknown): boolean {
  const a = canonicalJson(left); const b = canonicalJson(right);
  return a.ok && b.ok && a.value === b.value;
}
function asJson(value: unknown): JsonValue { return value as JsonValue; }

/** Definitions are immutable within their natural keys. */
export async function registerGradingContext(db: Database, tenant: TenantScope, context: GradingContext): Promise<Result<void, GradingError>> {
  const { question, evidence, evaluator } = context;
  const digest = evaluatorIdentity(evaluator);
  if (!digest.ok) return failure("register_context", evaluator.evaluator_definition_id, digest.error.detail);
  if (evaluator.prompt_digest !== instructionDigest(evaluator.instruction_text))
    return failure("register_context", evaluator.evaluator_definition_id, "prompt digest differs from canonical instruction text digest");
  if (evidence.is_incomplete !== (evidence.incompleteness_reason !== null))
    return failure("register_context", evidence.evidence_set_id, "incompleteness reason must match flag");
  if (evidence.references.some((reference) => !reference.kind))
    return failure("register_context", evidence.evidence_set_id, "new evidence references require classification");
  try {
    return await withTenant(db, tenant, async (trx) => {
      const q = await trx.selectFrom("observation.question_definition").selectAll().where("producer", "=", tenant.producer)
        .where("namespace", "=", tenant.namespace).where("question_id", "=", question.question_id)
        .where("question_version", "=", question.question_version).executeTakeFirst();
      if (q && !same([q.target_item_kinds, q.input_recipe, q.response_kind, q.allowed_values, q.missing_evidence_policy,
        q.abstain_semantics, q.unclear_semantics, q.interpretation_caveats, q.requires_repository_snapshot],
        [question.target_item_kinds, question.input_recipe, question.response_kind, question.allowed_values, question.missing_evidence_policy,
          question.abstain_semantics, question.unclear_semantics, question.interpretation_caveats, question.requires_repository_snapshot]))
        return failure("register_context", question.question_id, "question definition identity conflict");
      if (q && ((q.question_text !== null && q.question_text !== question.question_text)
        || (q.evidence_recipe_provenance !== null && !same(q.evidence_recipe_provenance, question.evidence_recipe_provenance))))
        return failure("register_context", question.question_id, "question text or recipe provenance conflict");
      if (!q) await trx.insertInto("observation.question_definition").values({ ...scope(tenant),
        question_id: question.question_id, question_version: question.question_version,
        target_item_kinds: json(asJson(question.target_item_kinds)), input_recipe: json(question.input_recipe),
        response_kind: question.response_kind, allowed_values: question.allowed_values === null ? null : json(asJson(question.allowed_values)),
        missing_evidence_policy: question.missing_evidence_policy, abstain_semantics: question.abstain_semantics,
        unclear_semantics: question.unclear_semantics, interpretation_caveats: question.interpretation_caveats,
        requires_repository_snapshot: question.requires_repository_snapshot,
        question_text: question.question_text ?? null,
        evidence_recipe_provenance: question.evidence_recipe_provenance ? json(asJson(question.evidence_recipe_provenance)) : null }).execute();
      const e = await trx.selectFrom("observation.evidence_set").selectAll().where("producer", "=", tenant.producer)
        .where("namespace", "=", tenant.namespace).where("evidence_set_id", "=", evidence.evidence_set_id).executeTakeFirst();
      if (e && !same([e.evidence_refs, e.is_incomplete, e.incompleteness_reason],
        [evidence.references, evidence.is_incomplete, evidence.incompleteness_reason]))
        return failure("register_context", evidence.evidence_set_id, "evidence set identity conflict");
      if (!e) await trx.insertInto("observation.evidence_set").values({ ...scope(tenant), evidence_set_id: evidence.evidence_set_id,
        evidence_refs: json(asJson(evidence.references)), is_incomplete: evidence.is_incomplete,
        incompleteness_reason: evidence.incompleteness_reason }).execute();
      const d = await trx.selectFrom("observation.evaluator_definition").selectAll().where("producer", "=", tenant.producer)
        .where("namespace", "=", tenant.namespace).where("evaluator_definition_id", "=", evaluator.evaluator_definition_id).executeTakeFirst();
      if (d && (d.identity_digest !== digest.value || !same([d.cost_metadata, d.seed, d.attempt_controls, d.instruction_text],
        [evaluator.cost_metadata, evaluator.seed, evaluator.attempt_controls, evaluator.instruction_text])))
        return failure("register_context", evaluator.evaluator_definition_id, "evaluator definition identity conflict");
      if (!d) await trx.insertInto("observation.evaluator_definition").values({ ...scope(tenant),
        evaluator_definition_id: evaluator.evaluator_definition_id, kind: evaluator.kind,
        backend_kind: evaluator.backend_kind, provider: evaluator.provider, model: evaluator.model,
        prompt_digest: evaluator.prompt_digest, config_digest: evaluator.config_digest,
        runtime_revision: evaluator.runtime_revision, cost_metadata: evaluator.cost_metadata === null ? null : json(evaluator.cost_metadata),
        seed: evaluator.seed, attempt_controls: evaluator.attempt_controls === null ? null : json(evaluator.attempt_controls),
        identity_digest: digest.value, instruction_text: evaluator.instruction_text }).execute();
      return ok(undefined);
    });
  } catch (cause) { return failure("register_context", question.question_id, String(cause)); }
}

async function validateIdentity(trx: DatabaseTransaction, tenant: TenantScope, identity: EvaluationIdentity): Promise<Result<{ readonly question: QuestionDefinition; readonly evidence: EvidenceSet; readonly evaluator: EvaluatorDefinition }, GradingError>> {
  const item = await trx.selectFrom("observation.item_occurrence").select(["item_kind"]).where("producer", "=", tenant.producer)
    .where("namespace", "=", tenant.namespace).where("occurrence_id", "=", identity.subject_occurrence_id).executeTakeFirst();
  if (!item) return failure("evaluate", identity.subject_occurrence_id, "subject occurrence does not exist in namespace");
  const q = await trx.selectFrom("observation.question_definition").selectAll().where("producer", "=", tenant.producer)
    .where("namespace", "=", tenant.namespace).where("question_id", "=", identity.question_id)
    .where("question_version", "=", identity.question_version).executeTakeFirst();
  if (!q) return failure("evaluate", identity.question_id, "question definition does not exist in namespace");
  if (!Array.isArray(q.target_item_kinds) || !q.target_item_kinds.includes(item.item_kind))
    return failure("evaluate", identity.question_id, "question does not target subject item kind");
  const e = await trx.selectFrom("observation.evidence_set").selectAll().where("producer", "=", tenant.producer)
    .where("namespace", "=", tenant.namespace).where("evidence_set_id", "=", identity.evidence_set_id).executeTakeFirst();
  if (!e) return failure("evaluate", identity.evidence_set_id, "evidence set does not exist in namespace");
  const d = await trx.selectFrom("observation.evaluator_definition").selectAll().where("producer", "=", tenant.producer)
    .where("namespace", "=", tenant.namespace).where("evaluator_definition_id", "=", identity.evaluator_definition_id).executeTakeFirst();
  if (!d) return failure("evaluate", identity.evaluator_definition_id, "evaluator definition does not exist in namespace");
  if (identity.config_digest !== d.config_digest) return failure("evaluate", identity.evaluator_definition_id, "config digest differs from evaluator definition");
  return ok({ question: { ...q, question_id: q.question_id as QuestionDefinition["question_id"],
    target_item_kinds: q.target_item_kinds as string[], input_recipe: q.input_recipe as QuestionDefinition["input_recipe"],
    response_kind: q.response_kind as QuestionDefinition["response_kind"], allowed_values: q.allowed_values as QuestionDefinition["allowed_values"],
    missing_evidence_policy: q.missing_evidence_policy as QuestionDefinition["missing_evidence_policy"] },
    evidence: { ...e, evidence_set_id: e.evidence_set_id as EvidenceSet["evidence_set_id"], references: e.evidence_refs as unknown as EvidenceSet["references"] },
    evaluator: { ...d, kind: d.kind as EvaluatorDefinition["kind"], instruction_text: d.instruction_text ?? "" } });
}

function validAnswer(answer: GradeAnswer, question: QuestionDefinition): boolean {
  if (!answer || typeof answer !== "object" || answer.kind !== question.response_kind) return false;
  if (answer.state === "abstain" || answer.state === "unclear")
    return typeof answer.reason === "string" && answer.reason.length > 0;
  if (answer.state !== "answered" || !("value" in answer)) return false;
  if (answer.kind === "boolean") return typeof answer.value === "boolean";
  if (answer.kind === "choice" || answer.kind === "ordinal")
    return typeof answer.value === "string" && (question.allowed_values?.includes(answer.value) ?? false);
  if (answer.kind === "numeric") return typeof answer.value === "number" && Number.isFinite(answer.value);
  if (answer.kind === "text") return typeof answer.value === "string";
  return canonicalJson(answer.value).ok;
}
function validOutcome(outcome: EvaluationOutcome, question: QuestionDefinition): boolean {
  if (!validAnswer(outcome.answer, question)) return false;
  if (outcome.confidence != null && (!Number.isFinite(outcome.confidence) || outcome.confidence < 0 || outcome.confidence > 1)) return false;
  if (outcome.cost != null && (!Number.isFinite(outcome.cost) || outcome.cost < 0)) return false;
  if (outcome.probabilities != null) {
    if (typeof outcome.probabilities !== "object" || Array.isArray(outcome.probabilities)) return false;
    for (const [label, probability] of Object.entries(outcome.probabilities)) {
      if (!Number.isFinite(probability) || probability < 0 || probability > 1) return false;
      if (question.allowed_values && !question.allowed_values.includes(label)) return false;
    }
  }
  return true;
}

export interface RunGradeInput {
  readonly identity: EvaluationIdentity;
  readonly runner: GradeRunner;
  /** Commit selected for this execution, independently of the pinned recipe descriptor. */
  readonly reviewed_commit?: string;
}
export interface RunGradeResult { readonly execution: Selectable<ObservationEvaluationExecution>; readonly observation: Selectable<ObservationGradeObservation> | null; readonly was_replay: boolean }
export type ManualRecoveryResult = { readonly state: "recovered"; readonly execution_id: string }
  | { readonly state: "missing" } | { readonly state: "not_running" } | { readonly state: "queued_job" };

/** An operator can fence a stranded manual call before submitting a new attempt label. */
export async function recoverManualExecution(db: Database, tenant: TenantScope, execution_id: string)
  : Promise<Result<ManualRecoveryResult, GradingError>> {
  try {
    return await withTenant(db, tenant, async (trx) => {
      const execution = await trx.selectFrom("observation.evaluation_execution").selectAll()
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("execution_id", "=", execution_id).forUpdate().executeTakeFirst();
      if (!execution) return ok({ state: "missing" });
      if (execution.status !== "running") return ok({ state: "not_running" });
      const job = await trx.selectFrom("observation.grading_job").select("job_id")
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("idempotency_digest", "=", execution.idempotency_digest).executeTakeFirst();
      if (job) return ok({ state: "queued_job" });
      await trx.updateTable("observation.evaluation_execution")
        .set({ status: "failed", ended_at: new Date(), error: "operator_recovery" })
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("execution_id", "=", execution_id).execute();
      return ok({ state: "recovered", execution_id });
    });
  } catch (cause) { return failure("recover_manual_evaluation", execution_id, String(cause)); }
}

/** Ingest and persist use separate short transactions; the runner is awaited between them. */
export async function runGrade(db: Database, tenant: TenantScope, input: RunGradeInput & {
  readonly lease?: { readonly job_id: string; readonly owner: string };
}): Promise<Result<RunGradeResult, GradingError>> {
  const { identity } = input;
  const digest = runGradeDigest(identity, input.reviewed_commit);
  if (!digest.ok) return failure("evaluate", identity.subject_occurrence_id, digest.error.detail);
  try {
    const scheduled = await withTenant(db, tenant, async (trx) => {
      const checked = await validateIdentity(trx, tenant, identity);
      if (!checked.ok) return checked;
      if (checked.value.evaluator.kind !== input.runner.kind)
        return failure("evaluate", identity.evaluator_definition_id, "runner kind differs from evaluator definition");
      const inserted = await trx.insertInto("observation.evaluation_execution").values({ ...scope(tenant),
        execution_id: randomUUID(), ...identity, idempotency_digest: digest.value,
        attempts: 1, retries: 0, started_at: new Date(), ended_at: null, status: "running",
        error: null, model_usage: null, cost: null, external_execution_id: null, provider_link: null,
        reproducibility_metadata: null })
        .onConflict((conflict) => conflict.columns(["producer", "namespace", "idempotency_digest"]).doNothing())
        .returningAll().executeTakeFirst();
      const execution = inserted ?? await trx.selectFrom("observation.evaluation_execution").selectAll()
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("idempotency_digest", "=", digest.value).executeTakeFirstOrThrow();
      return ok({ checked: checked.value, execution, is_owner: !!inserted });
    });
    if (!scheduled.ok) return scheduled;
    const { checked, execution, is_owner } = scheduled.value;
    if (!is_owner && (!input.lease || execution.status !== "running")) {
      let current = execution;
      for (let wait = 0; current.status === "running" && wait < 100; wait++) {
        await Bun.sleep(20);
        current = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluation_execution")
          .selectAll().where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
          .where("execution_id", "=", execution.execution_id).executeTakeFirstOrThrow());
      }
      if (current.status === "running") return failure("evaluate", identity.subject_occurrence_id, "execution is still running");
      const lease = input.lease;
      if (lease) await withTenant(db, tenant, async (trx) => {
        const claim = await trx.selectFrom("observation.grading_job").selectAll()
          .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
          .where("job_id", "=", lease.job_id).forUpdate().executeTakeFirst();
        if (claim?.state === "claimed" && claim.lease_owner === lease.owner
          && claim.lease_expires_at && claim.lease_expires_at.getTime() > Date.now())
          await trx.updateTable("observation.grading_job").set({ state: "terminal",
            terminal_cause: current.status === "completed" ? null : "runner_failed",
            lease_owner: null, lease_expires_at: null, updated_at: new Date() })
            .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
            .where("job_id", "=", claim.job_id).execute();
      });
      const observation = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.grade_observation")
        .selectAll().where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("execution_id", "=", execution.execution_id).executeTakeFirst());
      return ok({ execution: current, observation: observation ?? null, was_replay: true });
    }
    const { question, evidence, evaluator } = checked;
    const snapshot = question.requires_repository_snapshot
      ? repositorySnapshotEligibility(evidence, Number(question.input_recipe.minimum_repository_content ?? 1),
        input.reviewed_commit ?? "") : null;
    const blocked = snapshot !== null && snapshot.tag !== "eligible";
    const missing = evidence.is_incomplete && question.missing_evidence_policy === "fail";
    let result: RunnerResult;
    if (blocked || missing) result = failure("evaluate", evidence.evidence_set_id,
      evidence.incompleteness_reason ?? (snapshot?.tag === "missing_evidence" ? snapshot.payload.kind === "missing_source"
        ? snapshot.payload.detail : "repository evidence missing" : "evidence set is incomplete"));
    else if (evidence.is_incomplete && question.missing_evidence_policy === "abstain")
      result = ok({ answer: { state: "abstain", kind: question.response_kind, reason: evidence.incompleteness_reason ?? "incomplete evidence" } });
    else {
      try { result = await input.runner.run({ question, evidence, evaluator }); }
      catch (cause) { result = failure("grade_runner", evaluator.evaluator_definition_id, String(cause)); }
    }
    if (result.ok && !validOutcome(result.value, question))
      result = failure("evaluate", question.question_id, "answer or probabilities do not match question semantics");
    const outcome = result.ok ? result.value : null;
    return await withTenant(db, tenant, async (trx) => {
      if (input.lease) {
        const claim = await trx.selectFrom("observation.grading_job").selectAll()
          .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
          .where("job_id", "=", input.lease.job_id).forUpdate().executeTakeFirst();
        if (!claim || claim.state !== "claimed" || claim.lease_owner !== input.lease.owner
          || !claim.lease_expires_at || claim.lease_expires_at.getTime() <= Date.now())
          return failure("evaluate", identity.subject_occurrence_id, "claim expired before persist");
        if (!result.ok && claim.attempts < claim.retry_limit
          && result.error.operation !== "disclosure" && result.error.operation !== "evaluate") {
          await trx.updateTable("observation.grading_job").set({ state: "reclaimable",
            lease_owner: null, lease_expires_at: null, updated_at: new Date() })
            .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
            .where("job_id", "=", claim.job_id).execute();
          return failure("evaluate", identity.subject_occurrence_id, result.error.detail);
        }
      }
      const updated = await trx.updateTable("observation.evaluation_execution").set({
        status: outcome ? "completed" : "failed", ended_at: new Date(), error: result.ok ? null : result.error.detail,
        model_usage: outcome?.model_usage == null ? null : json(outcome.model_usage), cost: outcome?.cost ?? null,
        external_execution_id: outcome?.external_execution_id ?? null, provider_link: outcome?.provider_link ?? null,
        reproducibility_metadata: outcome?.reproducibility_metadata == null ? null : json(outcome.reproducibility_metadata),
      }).where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("execution_id", "=", execution.execution_id).where("status", "=", "running")
        .returningAll().executeTakeFirst();
      if (!updated) return failure("evaluate", identity.subject_occurrence_id, "execution already persisted");
      let observation: Selectable<ObservationGradeObservation> | null = null;
      if (outcome) observation = await trx.insertInto("observation.grade_observation").values({ ...scope(tenant),
        observation_id: randomUUID(), execution_id: execution.execution_id, subject_occurrence_id: identity.subject_occurrence_id,
        evidence_set_id: identity.evidence_set_id, question_id: identity.question_id, question_version: identity.question_version,
        evaluator_definition_id: identity.evaluator_definition_id, answer_kind: outcome.answer.kind,
        answer_state: outcome.answer.state, answer_payload: json(asJson(outcome.answer)),
        probabilities: outcome.probabilities == null ? null : json(asJson(outcome.probabilities)),
        confidence: outcome.confidence ?? null, normalized_score: null, decision_policy_id: null,
        decision_policy_version: null, reviewer_id: null, reviewer_details: null,
        comments: outcome.comments ?? null, rationale: outcome.rationale ?? null,
        quality_flags: json(asJson(outcome.quality_flags ?? [])), supersedes_observation_id: null })
        .returningAll().executeTakeFirstOrThrow();
      if (input.lease) await trx.updateTable("observation.grading_job").set({ state: "terminal",
        terminal_cause: outcome ? null : blocked || missing ? "ineligible"
          : !result.ok && result.error.operation === "disclosure"
          ? "disclosure_refused" : !result.ok && result.error.operation === "evaluate"
            ? "invalid_outcome" : "runner_failed",
        lease_owner: null, lease_expires_at: null, updated_at: new Date() })
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("job_id", "=", input.lease.job_id).execute();
      return ok({ execution: updated, observation, was_replay: false });
    });
  } catch (cause) { return failure("evaluate", identity.subject_occurrence_id, String(cause)); }
}

export async function startDelegatedExecution(db: Database, tenant: TenantScope, identity: EvaluationIdentity,
  reviewed_commit?: string)
  : Promise<Result<Selectable<ObservationEvaluationExecution>, GradingError>> {
  const digest = runGradeDigest(identity, reviewed_commit);
  if (!digest.ok) return failure("delegate", identity.subject_occurrence_id, digest.error.detail);
  try {
    return await withTenant(db, tenant, async (trx) => {
      const existing = await trx.selectFrom("observation.evaluation_execution").selectAll()
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("idempotency_digest", "=", digest.value).executeTakeFirst();
      if (existing) return ok(existing);
      const checked = await validateIdentity(trx, tenant, identity);
      if (!checked.ok) return checked;
      if (checked.value.evaluator.kind !== "model")
        return failure("delegate", identity.evaluator_definition_id, "only a model evaluator can be delegated");
      const inserted = await trx.insertInto("observation.evaluation_execution").values({ ...scope(tenant),
        execution_id: randomUUID(), ...identity, idempotency_digest: digest.value, attempts: 1, retries: 0,
        started_at: new Date(), ended_at: null, status: "running", error: null, model_usage: null, cost: null,
        external_execution_id: null, provider_link: null, reproducibility_metadata: null })
        .onConflict((conflict) => conflict.columns(["producer", "namespace", "idempotency_digest"]).doNothing())
        .returningAll().executeTakeFirst();
      return ok(inserted ?? await trx.selectFrom("observation.evaluation_execution").selectAll()
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("idempotency_digest", "=", digest.value).executeTakeFirstOrThrow());
    });
  } catch (cause) { return failure("delegate", identity.subject_occurrence_id, String(cause)); }
}

export interface HumanGradeInput extends EvaluationIdentity {
  readonly details: GradeDetails;
}
/** Human intake uses the same execution identity and only inserts new observations. */
export async function recordHumanGrade(db: Database, tenant: TenantScope, input: HumanGradeInput): Promise<Result<RunGradeResult, GradingError>> {
  const { details, ...identity } = input;
  const digest = evaluationDigest(identity);
  if (!digest.ok) return failure("human_grade", identity.subject_occurrence_id, digest.error.detail);
  try {
    return await withTenant(db, tenant, async (trx) => {
      const existing = await trx.selectFrom("observation.evaluation_execution").selectAll().where("producer", "=", tenant.producer)
        .where("namespace", "=", tenant.namespace).where("idempotency_digest", "=", digest.value).executeTakeFirst();
      if (existing) {
        const observation = await trx.selectFrom("observation.grade_observation").selectAll().where("producer", "=", tenant.producer)
          .where("namespace", "=", tenant.namespace).where("execution_id", "=", existing.execution_id).executeTakeFirst();
        if (observation && (observation.reviewer_id !== details.reviewer_id
          || observation.collection_mode !== (details.collection_mode ?? null)
          || observation.blind_assignment_id !== (details.blind_assignment_id ?? null)))
          return failure("human_grade", identity.subject_occurrence_id, "execution belongs to a different reviewer or collection");
        return ok({ execution: existing, observation: observation ?? null, was_replay: true });
      }
      const checked = await validateIdentity(trx, tenant, identity);
      if (!checked.ok) return checked;
      if (checked.value.evaluator.kind !== "human") return failure("human_grade", identity.evaluator_definition_id, "human evaluator required");
      if (!details.reviewer_id) return failure("human_grade", identity.subject_occurrence_id, "reviewer id required");
      if (!details.collection_mode || details.model_answers_visible === undefined || details.workflow_decisions_visible === undefined)
        return failure("human_grade", identity.subject_occurrence_id, "collection mode and visibility required");
      if (details.collection_mode === "blind") {
        const is_imported_annotation = identity.evaluator_definition_id === "langfuse-annotation-human";
        if ((!details.blind_assignment_id && !is_imported_annotation) || details.model_answers_visible || details.workflow_decisions_visible)
          return failure("human_grade", identity.subject_occurrence_id, "blind submission requires a hidden claimed assignment");
        if (details.blind_assignment_id) {
          const assignment = await trx.selectFrom("observation.blind_assignment").selectAll()
          .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
          .where("assignment_id", "=", details.blind_assignment_id).forUpdate().executeTakeFirst();
          if (!assignment || assignment.claim_owner !== details.reviewer_id || !assignment.expires_at
          || assignment.expires_at <= new Date() || assignment.submitted_observation_id
          || assignment.subject_occurrence_id !== identity.subject_occurrence_id
          || assignment.evidence_set_id !== identity.evidence_set_id || assignment.question_id !== identity.question_id
          || assignment.question_version !== identity.question_version)
            return failure("human_grade", identity.subject_occurrence_id, "blind assignment is unclaimed, expired, or mismatched");
        }
      } else if (details.blind_assignment_id) return failure("human_grade", identity.subject_occurrence_id, "in-context grade cannot use a blind assignment");
      if (!validAnswer(details.answer, checked.value.question)) return failure("human_grade", identity.question_id, "invalid answer");
      if (!validOutcome({ answer: details.answer, probabilities: details.probabilities, confidence: details.confidence }, checked.value.question))
        return failure("human_grade", identity.question_id, "invalid probability or confidence");
      if ((details.normalized_score === null) !== (details.decision_policy_id === null && details.decision_policy_version === null)
        || (details.normalized_score !== null && (!details.decision_policy_id || !details.decision_policy_version)))
        return failure("human_grade", identity.question_id, "normalized score requires a decision policy id and version");
      const execution_id = randomUUID();
      const now = new Date();
      const inserted = await trx.insertInto("observation.evaluation_execution").values({ ...scope(tenant), ...identity,
        execution_id, idempotency_digest: digest.value, attempts: 1, retries: 0, started_at: now, ended_at: now,
        status: "completed", error: null, model_usage: null, cost: null, external_execution_id: null,
        provider_link: null, reproducibility_metadata: null })
        .onConflict((conflict) => conflict.columns(["producer", "namespace", "idempotency_digest"]).doNothing())
        .returningAll().executeTakeFirst();
      if (!inserted) {
        const execution = await trx.selectFrom("observation.evaluation_execution").selectAll()
          .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
          .where("idempotency_digest", "=", digest.value).executeTakeFirstOrThrow();
        const observation = await trx.selectFrom("observation.grade_observation").selectAll()
          .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
          .where("execution_id", "=", execution.execution_id).executeTakeFirst();
        if (observation && (observation.reviewer_id !== details.reviewer_id
          || observation.collection_mode !== (details.collection_mode ?? null)
          || observation.blind_assignment_id !== (details.blind_assignment_id ?? null)))
          return failure("human_grade", identity.subject_occurrence_id, "execution belongs to a different reviewer or collection");
        return ok({ execution, observation: observation ?? null, was_replay: true });
      }
      const execution = inserted;
      const observation = await trx.insertInto("observation.grade_observation").values({ ...scope(tenant),
        observation_id: randomUUID(), execution_id, subject_occurrence_id: identity.subject_occurrence_id,
        evidence_set_id: identity.evidence_set_id, question_id: identity.question_id, question_version: identity.question_version,
        evaluator_definition_id: identity.evaluator_definition_id, answer_kind: details.answer.kind,
        answer_state: details.answer.state, answer_payload: json(asJson(details.answer)),
        probabilities: details.probabilities == null ? null : json(asJson(details.probabilities)),
        confidence: details.confidence, normalized_score: details.normalized_score,
        decision_policy_id: details.decision_policy_id, decision_policy_version: details.decision_policy_version,
        reviewer_id: details.reviewer_id, reviewer_details: details.reviewer_details == null ? null : json(details.reviewer_details),
        collection_mode: details.collection_mode, blind_assignment_id: details.blind_assignment_id ?? null,
        model_answers_visible: details.model_answers_visible,
        workflow_decisions_visible: details.workflow_decisions_visible,
        comments: details.comments, rationale: details.rationale, quality_flags: json(asJson(details.quality_flags)),
        supersedes_observation_id: details.supersedes_observation_id }).returningAll().executeTakeFirstOrThrow();
      if (details.blind_assignment_id) await trx.updateTable("observation.blind_assignment")
        .set({ submitted_observation_id: observation.observation_id })
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("assignment_id", "=", details.blind_assignment_id).execute();
      return ok({ execution, observation, was_replay: false });
    });
  } catch (cause) { return failure("human_grade", identity.subject_occurrence_id, String(cause)); }
}

export function readExecution(db: Database, tenant: TenantScope, execution_id: string): Promise<Selectable<ObservationEvaluationExecution> | null> {
  return withTenant(db, tenant, async (trx) => (await trx.selectFrom("observation.evaluation_execution").selectAll()
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("execution_id", "=", execution_id).executeTakeFirst()) ?? null);
}
export function listGrades(db: Database, tenant: TenantScope, occurrence_id: string, page: Page): Promise<GradePage | null> {
  return withTenant(db, tenant, async (trx) => {
    const item = await trx.selectFrom("observation.item_occurrence").select("occurrence_id")
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("occurrence_id", "=", occurrence_id).executeTakeFirst();
    if (!item) return null;
    const count = await trx.selectFrom("observation.grade_observation").select((eb) => eb.fn.countAll<number>().as("count"))
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("subject_occurrence_id", "=", occurrence_id).executeTakeFirstOrThrow();
    const rows = await trx.selectFrom("observation.grade_observation as g")
      .innerJoin("observation.evaluation_execution as x", (join) => join.onRef("x.producer", "=", "g.producer")
        .onRef("x.namespace", "=", "g.namespace").onRef("x.execution_id", "=", "g.execution_id"))
      .innerJoin("observation.evaluator_definition as d", (join) => join.onRef("d.producer", "=", "g.producer")
        .onRef("d.namespace", "=", "g.namespace").onRef("d.evaluator_definition_id", "=", "g.evaluator_definition_id"))
      .select([
        sql<GradeListingItem["observation"]>`to_jsonb(g)`.as("observation"),
        sql<GradeListingItem["execution"]>`to_jsonb(x)`.as("execution"),
        sql<GradeListingItem["evaluator"]>`to_jsonb(d)`.as("evaluator"),
      ])
      .where("g.producer", "=", tenant.producer).where("g.namespace", "=", tenant.namespace)
      .where("g.subject_occurrence_id", "=", occurrence_id)
      .orderBy("g.recorded_at", "asc").orderBy("g.observation_id", "asc").limit(page.limit).offset(page.offset).execute();
    const items: GradeListingItem[] = rows.map(({ observation, execution, evaluator }) => ({
      observation: { ...observation, collection_mode: observation.collection_mode ?? "unknown" },
      answer: observation.answer_payload, evaluator, execution,
    }));
    return { items, total: Number(count.count), ...page };
  });
}
