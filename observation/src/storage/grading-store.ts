import { sql, type Selectable } from "kysely";
import { canonicalJson } from "canonical-json";
import type { JsonValue, Result } from "../domain/primitives";
import { err, ok } from "../domain/primitives";
import type { QuestionId } from "../domain/identity";
import type { QuestionDefinition } from "../grading/question";
import { evaluatorIdentity, instructionDigest, type EvaluatorDefinition } from "../grading/evaluator";
import type { GradeListingItem } from "../grading/observation";
import type { GradingError } from "../grading/runner";
import { jsonText, withTenant, type Database, type TenantScope } from "./database";
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
export function listGrades(db: Database, tenant: TenantScope, occurrence_id: string, page: Page): Promise<GradePage | null> {
  return withTenant(db, tenant, async (trx) => {
    const item = await trx.selectFrom("observation.item_occurrence").select("occurrence_id")
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("occurrence_id", "=", occurrence_id).executeTakeFirst();
    if (!item) return null;
    const graded = trx.selectFrom("observation.grade_observation as g")
      .innerJoin("observation.evaluation_execution as x", (join) => join.onRef("x.producer", "=", "g.producer")
        .onRef("x.namespace", "=", "g.namespace").onRef("x.execution_id", "=", "g.execution_id"))
      .where("g.producer", "=", tenant.producer).where("g.namespace", "=", tenant.namespace)
      .where("x.subject_occurrence_id", "=", occurrence_id);
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
      observation, answer: observation.answer_payload, evaluator, execution,
    }));
    return { items, total: Number(count.count), ...page };
  });
}
