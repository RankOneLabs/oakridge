import { sql, type Selectable } from "kysely";
import { canonicalJson } from "canonical-json";
import type { JsonValue, Result } from "../domain/primitives";
import { err, ok } from "../domain/primitives";
import type { EvaluatorDefinitionId, EvidenceSetId, ExecutionId, GradeObservationId, ItemOccurrenceId, LogicalItemId, QuestionId, ReviewerId, RunId } from "../domain/identity";
import { subjectTaskProblem, NO_CAPTURE_PINS, type CaptureConfiguration } from "../grading/evidence";
import type { QuestionDefinition, QuestionKey } from "../grading/question";
import { evaluatorIdentity, instructionDigest, type EvaluatorDefinition } from "../grading/evaluator";
import { humanChoiceAnswer, submissionAttemptLabel, submissionDigest } from "../grading/execution";
import { observationIdOf, type GradeAnswer, type GradeListingItem } from "../grading/observation";
import type { GradingError } from "../grading/runner";
import { jsonText, withTenant, type Database, type DatabaseTransaction, type TenantScope } from "./database";
import type { ObservationEvaluationExecution, ObservationQuestionDefinition } from "./db-types";
import type { Page } from "./projection-store";

export interface GradePage extends Page { readonly total: number; readonly items: readonly GradeListingItem[] }

const scope = (tenant: TenantScope) => ({ producer: tenant.producer, namespace: tenant.namespace });
function failure(operation: string, entity_id: string, detail: string): Result<never, GradingError> {
  return err({ operation, entity_id, detail });
}
function same(left: unknown, right: unknown): boolean {
  const a = canonicalJson(left); const b = canonicalJson(right);
  return a.ok && b.ok && a.value === b.value;
}
function asJson(value: unknown): JsonValue { return value as JsonValue; }

export function questionFromRow(row: Selectable<ObservationQuestionDefinition>): QuestionDefinition {
  return { question_id: row.question_id as QuestionId, question_version: row.question_version, item_kind: row.item_kind,
    question_text: row.question_text, response_kind: row.response_kind as QuestionDefinition["response_kind"],
    allowed_values: row.allowed_values as QuestionDefinition["allowed_values"],
    missing_evidence_policy: row.missing_evidence_policy as QuestionDefinition["missing_evidence_policy"],
    abstain_semantics: row.abstain_semantics, unclear_semantics: row.unclear_semantics,
    interpretation_caveats: row.interpretation_caveats };
}

/** Definitions are immutable within their natural keys: a repeat is a no-op, a change is refused. */
export async function registerQuestion(db: Database, tenant: TenantScope, question: QuestionDefinition): Promise<Result<void, GradingError>> {
  if ((question.response_kind === "choice" || question.response_kind === "ordinal")
    && (!question.allowed_values || question.allowed_values.length === 0))
    return failure("register_question", question.question_id, "choice question requires allowed values");
  try {
    return await withTenant(db, tenant, async (trx) => {
      const stored = await trx.selectFrom("observation.question_definition").selectAll().where("producer", "=", tenant.producer)
        .where("namespace", "=", tenant.namespace).where("question_id", "=", question.question_id)
        .where("question_version", "=", question.question_version).executeTakeFirst();
      if (stored) return same(questionFromRow(stored), question) ? ok(undefined)
        : failure("register_question", question.question_id, "question definition identity conflict");
      await trx.insertInto("observation.question_definition").values({ ...scope(tenant),
        question_id: question.question_id, question_version: question.question_version, item_kind: question.item_kind,
        response_kind: question.response_kind, allowed_values: question.allowed_values === null ? null : jsonText(asJson(question.allowed_values)),
        missing_evidence_policy: question.missing_evidence_policy, abstain_semantics: question.abstain_semantics,
        unclear_semantics: question.unclear_semantics, interpretation_caveats: question.interpretation_caveats,
        question_text: question.question_text }).execute();
      return ok(undefined);
    });
  } catch (cause) { return failure("register_question", question.question_id, String(cause)); }
}

export async function registerEvaluator(db: Database, tenant: TenantScope, evaluator: EvaluatorDefinition): Promise<Result<void, GradingError>> {
  const digest = evaluatorIdentity(evaluator);
  if (!digest.ok) return failure("register_evaluator", evaluator.evaluator_definition_id, digest.error.detail);
  if (evaluator.prompt_digest !== instructionDigest(evaluator.instruction_text))
    return failure("register_evaluator", evaluator.evaluator_definition_id, "prompt digest differs from canonical instruction text digest");
  try {
    return await withTenant(db, tenant, async (trx) => {
      const stored = await trx.selectFrom("observation.evaluator_definition").selectAll().where("producer", "=", tenant.producer)
        .where("namespace", "=", tenant.namespace).where("evaluator_definition_id", "=", evaluator.evaluator_definition_id).executeTakeFirst();
      if (stored) return stored.identity_digest === digest.value && same([stored.cost_metadata, stored.seed, stored.attempt_controls, stored.instruction_text],
        [evaluator.cost_metadata, evaluator.seed, evaluator.attempt_controls, evaluator.instruction_text]) ? ok(undefined)
        : failure("register_evaluator", evaluator.evaluator_definition_id, "evaluator definition identity conflict");
      await trx.insertInto("observation.evaluator_definition").values({ ...scope(tenant),
        evaluator_definition_id: evaluator.evaluator_definition_id, kind: evaluator.kind,
        backend_kind: evaluator.backend_kind, provider: evaluator.provider, model: evaluator.model,
        prompt_digest: evaluator.prompt_digest, config_digest: evaluator.config_digest,
        runtime_revision: evaluator.runtime_revision, cost_metadata: evaluator.cost_metadata === null ? null : jsonText(evaluator.cost_metadata),
        seed: evaluator.seed, attempt_controls: evaluator.attempt_controls === null ? null : jsonText(evaluator.attempt_controls),
        identity_digest: digest.value, instruction_text: evaluator.instruction_text }).execute();
      return ok(undefined);
    });
  } catch (cause) { return failure("register_evaluator", evaluator.evaluator_definition_id, String(cause)); }
}

export function readExecution(db: Database, tenant: TenantScope, execution_id: string): Promise<Selectable<ObservationEvaluationExecution> | null> {
  return withTenant(db, tenant, async (trx) => (await trx.selectFrom("observation.evaluation_execution").selectAll()
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("execution_id", "=", execution_id).executeTakeFirst()) ?? null);
}

/** An occurrence's answers are found through its executions, which own the measurement identity. */
export function listGrades(db: Database, tenant: TenantScope, occurrence_id: string, page: Page, task_id?: LogicalItemId): Promise<GradePage | null> {
  return withTenant(db, tenant, async (trx) => {
    const item = await trx.selectFrom("observation.item_occurrence").select("occurrence_id")
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("occurrence_id", "=", occurrence_id).executeTakeFirst();
    if (!item) return null;
    let graded = trx.selectFrom("observation.grade_observation as g")
      .innerJoin("observation.evaluation_execution as x", (join) => join.onRef("x.producer", "=", "g.producer")
        .onRef("x.namespace", "=", "g.namespace").onRef("x.execution_id", "=", "g.execution_id"))
      .where("g.producer", "=", tenant.producer).where("g.namespace", "=", tenant.namespace)
      .where("x.subject_occurrence_id", "=", occurrence_id);
    if (task_id !== undefined) graded = graded.where("x.task_id", "=", task_id);
    const count = await graded.select((eb) => eb.fn.countAll<number>().as("count")).executeTakeFirstOrThrow();
    const rows = await graded
      .innerJoin("observation.evaluator_definition as d", (join) => join.onRef("d.producer", "=", "x.producer")
        .onRef("d.namespace", "=", "x.namespace").onRef("d.evaluator_definition_id", "=", "x.evaluator_definition_id"))
      .select([
        sql<GradeListingItem["observation"]>`to_jsonb(g)`.as("observation"),
        sql<GradeListingItem["execution"]>`to_jsonb(x)`.as("execution"),
        sql<GradeListingItem["evaluator"]>`to_jsonb(d)`.as("evaluator"),
      ])
      .orderBy("g.recorded_at", "asc").orderBy("g.observation_id", "asc").limit(page.limit).offset(page.offset).execute();
    const items: GradeListingItem[] = rows.map(({ observation, execution, evaluator }) => ({
      task_id: execution.task_id, observation, answer: observation.answer_payload, evaluator, execution,
    }));
    return { items, total: Number(count.count), ...page };
  });
}

/** The definitions startup registers for one tenant. */
export interface DefinitionSet { readonly questions: readonly QuestionDefinition[]; readonly evaluators: readonly EvaluatorDefinition[] }
/** Idempotent: a repeat registers nothing new, and an earlier definition is never altered or
 * removed, so every pin written under an older configuration stays readable. */
export async function registerDefinitions(db: Database, tenant: TenantScope, definitions: DefinitionSet): Promise<Result<void, GradingError>> {
  for (const question of definitions.questions) {
    const registered = await registerQuestion(db, tenant, question);
    if (!registered.ok) return registered;
  }
  for (const evaluator of definitions.evaluators) {
    const registered = await registerEvaluator(db, tenant, evaluator);
    if (!registered.ok) return registered;
  }
  return ok(undefined);
}

// ------------------------------------------------------------- human submissions ---

/** What a reviewer submits. The reviewer comes from the credential; evidence and evaluator from the pin. */
export interface HumanSubmission extends QuestionKey {
  readonly task_id?: LogicalItemId | null;
  readonly occurrence_id: ItemOccurrenceId;
  readonly submission_id: string;
  readonly answer: string;
  readonly rationale: string | null;
  readonly corrects_observation_id: GradeObservationId | null;
}
/** The durable result of a submission; a repeat of its id returns this same result. */
export interface RecordedSubmission {
  readonly task_id: LogicalItemId | null;
  readonly submission_id: string;
  readonly reviewer_id: ReviewerId;
  readonly observation_id: GradeObservationId;
  readonly execution_id: ExecutionId;
  readonly evidence_set_id: EvidenceSetId;
  readonly evaluator_definition_id: EvaluatorDefinitionId;
  readonly occurrence_id: ItemOccurrenceId;
  readonly run_id: RunId;
  readonly question: QuestionKey;
  readonly answer: GradeAnswer;
  readonly rationale: string | null;
  readonly corrects_observation_id: GradeObservationId | null;
  readonly recorded_at: Date;
}
export type SubmissionOutcome = { readonly status: "recorded" | "duplicate"; readonly submission: RecordedSubmission };
/** Why a submission recorded nothing. Only the selected question's own readiness can make it `not_ready`. */
export type SubmissionRefusal =
  | { readonly kind: "item_not_found"; readonly occurrence_id: ItemOccurrenceId }
  | { readonly kind: "task_required"; readonly question: QuestionKey }
  | { readonly kind: "task_not_applicable"; readonly question: QuestionKey }
  | { readonly kind: "question_not_pinned"; readonly question: QuestionKey }
  | { readonly kind: "not_ready"; readonly question: QuestionKey; readonly code: string; readonly detail: string }
  | { readonly kind: "invalid_answer"; readonly question: QuestionKey; readonly detail: string; readonly allowed_values: readonly JsonValue[] }
  | { readonly kind: "no_human_evaluator"; readonly question: QuestionKey }
  | { readonly kind: "not_correctable"; readonly corrects_observation_id: GradeObservationId; readonly detail: string }
  /** `current_observation_id` is null when the reviewer has no current answer left to correct. */
  | { readonly kind: "stale_correction"; readonly corrects_observation_id: GradeObservationId; readonly current_observation_id: GradeObservationId | null }
  | { readonly kind: "correction_required"; readonly current_observation_id: GradeObservationId };

const refuse = (refusal: SubmissionRefusal): Result<never, SubmissionRefusal> => err(refusal);

async function readRecordedSubmission(trx: DatabaseTransaction, tenant: TenantScope, submission_id: string, execution_id: string): Promise<RecordedSubmission | null> {
  const row = await trx.selectFrom("observation.grade_observation as g")
    .innerJoin("observation.evaluation_execution as x", (join) => join.onRef("x.producer", "=", "g.producer")
      .onRef("x.namespace", "=", "g.namespace").onRef("x.execution_id", "=", "g.execution_id"))
    .select(["g.observation_id", "g.execution_id", "g.reviewer_id", "g.answer_payload", "g.rationale", "g.supersedes_observation_id", "g.recorded_at",
      "x.task_id", "x.evidence_set_id", "x.evaluator_definition_id", "x.subject_occurrence_id", "x.run_id", "x.question_id", "x.question_version"])
    .where("g.producer", "=", tenant.producer).where("g.namespace", "=", tenant.namespace).where("g.execution_id", "=", execution_id).executeTakeFirst();
  return row ? { task_id: row.task_id as LogicalItemId | null, submission_id, reviewer_id: row.reviewer_id as ReviewerId, observation_id: row.observation_id as GradeObservationId, execution_id: row.execution_id as ExecutionId,
    evidence_set_id: row.evidence_set_id as EvidenceSetId, evaluator_definition_id: row.evaluator_definition_id as EvaluatorDefinitionId,
    occurrence_id: row.subject_occurrence_id as ItemOccurrenceId, run_id: row.run_id as RunId,
    question: { question_id: row.question_id as QuestionId, question_version: row.question_version }, answer: row.answer_payload as unknown as GradeAnswer,
    rationale: row.rationale, corrects_observation_id: row.supersedes_observation_id as GradeObservationId | null, recorded_at: row.recorded_at } : null;
}

/** This reviewer's answers to one question of one item, in recording order. */
function readOwnAnswers(trx: DatabaseTransaction, tenant: TenantScope, evidence_set_id: string, reviewer_id: string) {
  return trx.selectFrom("observation.grade_observation as g")
    .innerJoin("observation.evaluation_execution as x", (join) => join.onRef("x.producer", "=", "g.producer")
      .onRef("x.namespace", "=", "g.namespace").onRef("x.execution_id", "=", "g.execution_id"))
    .select(["g.observation_id", "g.supersedes_observation_id"]).where("g.producer", "=", tenant.producer).where("g.namespace", "=", tenant.namespace)
    .where("x.evidence_set_id", "=", evidence_set_id).where("g.reviewer_id", "=", reviewer_id).orderBy("g.recorded_at").orderBy("g.observation_id").execute();
}

/**
 * Records one reviewer answer against the question's pinned human evaluator and its frozen evidence,
 * both resolved here, never taken from the request. A repeated submission id changes nothing and
 * returns its original result. The reviewer's submissions are serialized, so a retry and a second
 * tab cannot both become the reviewer's current answer. It writes only execution and observation
 * rows: no provider request, no admission and no write outside this service.
 */
export async function submitHumanAnswer(db: Database, tenant: TenantScope, reviewer_id: string, input: HumanSubmission, configuration: CaptureConfiguration = NO_CAPTURE_PINS): Promise<Result<SubmissionOutcome, SubmissionRefusal>> {
  const submission = { reviewer_id, submission_id: input.submission_id };
  const digest = submissionDigest(submission);
  if (!digest.ok) throw new Error(digest.error.detail);
  const execution_id = digest.value;
  const question: QuestionKey = { question_id: input.question_id, question_version: input.question_version };
  return withTenant(db, tenant, async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenant.producer}:${tenant.namespace}:${reviewer_id}:submissions`}, 0))`.execute(trx);
    const repeated = await readRecordedSubmission(trx, tenant, input.submission_id, execution_id);
    if (repeated) return ok({ status: "duplicate", submission: repeated });
    const item = await trx.selectFrom("observation.item_occurrence").select(["occurrence_id", "run_id"]).where("producer", "=", tenant.producer)
      .where("namespace", "=", tenant.namespace).where("occurrence_id", "=", input.occurrence_id).executeTakeFirst();
    if (!item) return refuse({ kind: "item_not_found", occurrence_id: input.occurrence_id });
    const subjects = await trx.selectFrom("observation.evidence_set").select(["task_id"])
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("subject_occurrence_id", "=", input.occurrence_id).where("question_id", "=", input.question_id)
      .where("question_version", "=", input.question_version).execute();
    const declared = configuration.pins.find((pin) => pin.question_id === input.question_id && pin.question_version === input.question_version);
    const task_id = input.task_id ?? null;
    const task_problem = subjectTaskProblem({ pinned_tasks: subjects.map((set) => set.task_id as LogicalItemId | null), scope: declared, task_id });
    if (task_problem) return refuse({ kind: task_problem, question });
    const evidence = await trx.selectFrom("observation.evidence_set").selectAll().where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("subject_occurrence_id", "=", input.occurrence_id).where("task_id", task_id === null ? "is" : "=", task_id)
      .where("question_id", "=", input.question_id).where("question_version", "=", input.question_version).executeTakeFirst();
    if (!evidence) return refuse({ kind: "question_not_pinned", question });
    if (evidence.readiness !== "ready") return refuse({ kind: "not_ready", question, code: evidence.not_ready_code ?? "", detail: evidence.not_ready_detail ?? "" });
    const definition = questionFromRow(await trx.selectFrom("observation.question_definition").selectAll().where("producer", "=", tenant.producer)
      .where("namespace", "=", tenant.namespace).where("question_id", "=", input.question_id).where("question_version", "=", input.question_version).executeTakeFirstOrThrow());
    const answer = humanChoiceAnswer(definition, input.answer);
    if (!answer.ok) return refuse({ kind: "invalid_answer", question, detail: answer.error, allowed_values: definition.allowed_values ?? [] });
    const human = await trx.selectFrom("observation.evaluator_definition").select("evaluator_definition_id").where("producer", "=", tenant.producer)
      .where("namespace", "=", tenant.namespace).where("kind", "=", "human").where("evaluator_definition_id", "in", evidence.pinned_evaluator_definition_ids).executeTakeFirst();
    if (!human) return refuse({ kind: "no_human_evaluator", question });
    const own = await readOwnAnswers(trx, tenant, evidence.evidence_set_id, reviewer_id);
    const replaced = new Set(own.flatMap((row) => row.supersedes_observation_id ? [row.supersedes_observation_id] : []));
    const current = (own.filter((row) => !replaced.has(row.observation_id)).at(-1)?.observation_id ?? null) as GradeObservationId | null;
    if (input.corrects_observation_id === null) {
      if (current) return refuse({ kind: "correction_required", current_observation_id: current });
    } else {
      if (!own.some((row) => row.observation_id === input.corrects_observation_id))
        return refuse({ kind: "not_correctable", corrects_observation_id: input.corrects_observation_id, detail: "a correction replaces this reviewer's own earlier answer to this question" });
      if (current !== input.corrects_observation_id)
        return refuse({ kind: "stale_correction", corrects_observation_id: input.corrects_observation_id, current_observation_id: current });
    }
    const observation_id = observationIdOf(execution_id as unknown as ExecutionId);
    await trx.insertInto("observation.evaluation_execution").values({ task_id, ...scope(tenant), execution_id, run_id: item.run_id, subject_occurrence_id: input.occurrence_id,
      evidence_set_id: evidence.evidence_set_id, question_id: input.question_id, question_version: input.question_version, evaluator_definition_id: human.evaluator_definition_id,
      attempt_label: submissionAttemptLabel(submission), idempotency_digest: execution_id, status: "completed", lease_owner: null, lease_expires_at: null,
      terminal_cause: null, started_at: sql<Date>`clock_timestamp()`, ended_at: sql<Date>`clock_timestamp()`, error: null, model_usage: null, cost: null,
      external_execution_id: null, provider_link: null, reproducibility_metadata: null }).execute();
    await trx.insertInto("observation.grade_observation").values({ ...scope(tenant), observation_id, execution_id, answer_kind: answer.value.kind, answer_state: answer.value.state,
      answer_payload: jsonText(answer.value as unknown as JsonValue), probabilities: null, confidence: null, reviewer_id, reviewer_details: null, comments: null,
      rationale: input.rationale, quality_flags: jsonText([]), supersedes_observation_id: input.corrects_observation_id }).execute();
    const recorded = await readRecordedSubmission(trx, tenant, input.submission_id, execution_id);
    if (!recorded) throw new Error(`submission ${input.submission_id} was not recorded`);
    return ok({ status: "recorded", submission: recorded });
  });
}
