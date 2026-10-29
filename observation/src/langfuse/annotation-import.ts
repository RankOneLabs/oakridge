import { z } from "zod";
import { err, ok, type Result } from "../domain/primitives";
import type { GradeAnswer } from "../grading/observation";
import type { QuestionDefinition } from "../grading/question";
import { acceptHumanGrade } from "../runners/human-intake";
import type { LangfuseConfig } from "./config";
import type { LangfuseHttpClient } from "./http-client";
import type { LangfuseError } from "../ports/evaluation-backend";
import { registerGradingContext, type GradeDetails } from "../storage/grading-store";
import { withTenant, type Database, type TenantScope } from "../storage/database";
import { upsertLangfuseMapping } from "../storage/langfuse-store";
import { evidenceSetDigest } from "./mapping";
import { scoreConfigName } from "./score-config";
import type { CanonicalDigest, EvidenceSetId, ExecutionId, GradeObservationId, ItemOccurrenceId, QuestionId } from "../domain/identity";
import type { EvidenceSet } from "../grading/evidence";
import type { EvaluatorDefinition } from "../grading/evaluator";

export interface AnnotationImportInput { readonly mapping_key: CanonicalDigest; readonly queue_item_id: string;
  readonly score_id: string; readonly allow_notes: boolean }
export interface AnnotationImportResult { readonly observation_id: string; readonly mapping_key: string;
  readonly queue_item_id: string; readonly score_id: string; readonly was_replay: boolean }

const queueSchema = z.object({ id: z.string().min(1), queueId: z.string().min(1), objectId: z.string().min(1),
  objectType: z.literal("OBSERVATION"), status: z.literal("COMPLETED") });
const scoreSchema = z.object({ id: z.string().min(1), projectId: z.string().min(1), name: z.string().min(1),
  source: z.literal("ANNOTATION"), value: z.union([z.boolean(), z.string(), z.number()]),
  dataType: z.enum(["BOOLEAN", "CATEGORICAL", "NUMERIC"]), updatedAt: z.iso.datetime(),
  timestamp: z.iso.datetime(), comment: z.string().nullable().optional(), configId: z.string().min(1),
  queueId: z.string().min(1), authorUserId: z.string().min(1),
  subject: z.object({ kind: z.literal("observation"), id: z.string().min(1), traceId: z.string().min(1) }) });
const scoresSchema = z.object({ data: z.array(scoreSchema) });
const configSchema = z.object({ id: z.string().min(1), name: z.string().min(1),
  dataType: z.enum(["BOOLEAN", "CATEGORICAL", "NUMERIC"]),
  categories: z.array(z.object({ label: z.string(), value: z.number() })).nullable().optional() });

function failure(entity_id: string, detail: string): Result<never, LangfuseError> {
  return err({ operation: "annotation_import", entity_id, detail });
}

function answerForScore(question: QuestionDefinition, score: z.infer<typeof scoreSchema>): Result<GradeAnswer, LangfuseError> {
  if (question.response_kind === "boolean" && score.dataType === "BOOLEAN" && typeof score.value === "boolean")
    return ok({ state: "answered", kind: "boolean", value: score.value });
  if ((question.response_kind === "choice" || question.response_kind === "ordinal")
    && score.dataType === "CATEGORICAL" && typeof score.value === "string"
    && question.allowed_values?.includes(score.value))
    return ok({ state: "answered", kind: question.response_kind, value: score.value });
  if (question.response_kind === "numeric" && score.dataType === "NUMERIC" && typeof score.value === "number"
    && Number.isFinite(score.value))
    return ok({ state: "answered", kind: "numeric", value: score.value });
  return failure(score.id, "annotation value is outside the question domain");
}

const HUMAN_EVALUATOR: EvaluatorDefinition = { evaluator_definition_id: "langfuse-annotation-human", kind: "human",
  backend_kind: "langfuse", provider: "langfuse", model: null, prompt_digest: "langfuse-annotation/v1",
  config_digest: "langfuse-annotation/v1", runtime_revision: "1", cost_metadata: null, seed: null,
  attempt_controls: null };

/** Fetches and authenticates one completed UI annotation, then uses the ordinary human intake. */
export async function importLangfuseAnnotation(db: Database, tenant: TenantScope, config: LangfuseConfig,
  client: LangfuseHttpClient, input: AnnotationImportInput): Promise<Result<AnnotationImportResult, LangfuseError>> {
  const queue_id = config.annotation_queue_id;
  if (!queue_id) return failure(input.mapping_key, "annotation queue is not configured");
  const pinned = await withTenant(db, tenant, async (trx) => {
    const row = await trx.selectFrom("observation.langfuse_mapping").selectAll()
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("mapping_key", "=", input.mapping_key).executeTakeFirst();
    if (!row || !row.trace_id || !row.observation_id) return null;
    const [occurrences, sets, questions, mapped] = await Promise.all([
      trx.selectFrom("observation.item_occurrence").select("occurrence_id")
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("occurrence_id", "=", row.occurrence_id).execute(),
      trx.selectFrom("observation.evidence_set").selectAll()
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("evidence_set_id", "=", row.evidence_set_id).execute(),
      trx.selectFrom("observation.question_definition").selectAll()
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("question_id", "=", row.question_id).where("question_version", "=", row.question_version).execute(),
      trx.selectFrom("observation.langfuse_mapping").select(["occurrence_id", "evidence_set_id"])
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("observation_id", "=", row.observation_id).execute(),
    ]);
    if (occurrences.length !== 1 || sets.length !== 1 || questions.length !== 1
      || new Set(mapped.map((value) => `${value.occurrence_id}\0${value.evidence_set_id}`)).size !== 1) return null;
    return { row, evidence: sets[0]!, question: questions[0]! };
  });
  if (!pinned) return failure(input.mapping_key, "annotation does not resolve to one pinned occurrence and evidence set");
  const { row } = pinned;
  const queueClaim = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.langfuse_mapping")
    .selectAll().where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("queue_item_id", "=", input.queue_item_id)
    .where("attempt_id", "=", `queue:${input.queue_item_id}`).execute());
  if (queueClaim.length !== 1 || queueClaim[0]!.occurrence_id !== row.occurrence_id
    || queueClaim[0]!.evidence_set_id !== row.evidence_set_id
    || queueClaim[0]!.observation_id !== row.observation_id)
    return failure(input.queue_item_id, "queue item has no verified blinded target claim");
  const evidenceDigest = evidenceSetDigest({ evidence_set_id: row.evidence_set_id as EvidenceSetId,
    references: pinned.evidence.evidence_refs as unknown as EvidenceSet["references"],
    is_incomplete: pinned.evidence.is_incomplete, incompleteness_reason: pinned.evidence.incompleteness_reason });
  if (!evidenceDigest.ok || evidenceDigest.value !== row.evidence_set_digest)
    return failure(input.mapping_key, "mapping does not match the frozen evidence set");
  const queue = await client.request({ operation: "read_annotation_queue_item", entity_id: input.queue_item_id,
    method: "GET", path: `/api/public/annotation-queues/${encodeURIComponent(queue_id)}/items/${encodeURIComponent(input.queue_item_id)}`,
    response: queueSchema });
  if (!queue.ok) return queue;
  if (queue.value.id !== input.queue_item_id || queue.value.queueId !== queue_id || queue.value.objectId !== row.observation_id)
    return failure(input.queue_item_id, "queue item does not identify the pinned observation");
  const params = new URLSearchParams({ id: input.score_id, fields: "details,subject,annotation", limit: "100" });
  const scores = await client.request({ operation: "read_annotation_score", entity_id: input.score_id,
    method: "GET", path: `/api/public/v3/scores?${params}`, response: scoresSchema });
  if (!scores.ok) return scores;
  const score = scores.value.data.find((candidate) => candidate.id === input.score_id);
  if (!score || scores.value.data.filter((candidate) => candidate.id === input.score_id).length !== 1
    || score.projectId !== config.project_id || score.queueId !== queue_id
    || score.subject.id !== row.observation_id || score.subject.traceId !== row.trace_id
    || score.name !== scoreConfigName(row.question_id, row.question_version))
    return failure(input.score_id, "score does not authenticate to this queue item and question");
  const remoteConfig = await client.request({ operation: "read_annotation_score_config", entity_id: score.configId,
    method: "GET", path: `/api/public/score-configs/${encodeURIComponent(score.configId)}`, response: configSchema });
  if (!remoteConfig.ok) return remoteConfig;
  if (remoteConfig.value.id !== score.configId || remoteConfig.value.name !== score.name
    || remoteConfig.value.dataType !== score.dataType) return failure(score.id, "score config differs from pinned question");
  const question = { ...pinned.question, question_id: pinned.question.question_id as QuestionId,
    target_item_kinds: pinned.question.target_item_kinds as string[], input_recipe: pinned.question.input_recipe as QuestionDefinition["input_recipe"],
    response_kind: pinned.question.response_kind as QuestionDefinition["response_kind"],
    allowed_values: pinned.question.allowed_values as QuestionDefinition["allowed_values"],
    missing_evidence_policy: pinned.question.missing_evidence_policy as QuestionDefinition["missing_evidence_policy"] };
  if (score.dataType === "CATEGORICAL" && JSON.stringify(remoteConfig.value.categories?.map((category) => category.label))
    !== JSON.stringify(question.allowed_values)) return failure(score.id, "score config categories differ from allowed values");
  const answer = answerForScore(question, score);
  if (!answer.ok) return answer;
  const attempt_label = `annotation:${Date.parse(score.updatedAt)}:${score.id}`;
  const previous = await withTenant(db, tenant, async (trx) => {
    const records = await trx.selectFrom("observation.langfuse_mapping").selectAll()
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("queue_item_id", "=", input.queue_item_id).where("question_id", "=", row.question_id)
      .where("question_version", "=", row.question_version).orderBy("created_at", "desc").execute();
    const imported = records.filter((record) => record.attempt_id.startsWith("annotation:"));
    if (imported.some((record) => record.occurrence_id !== row.occurrence_id || record.evidence_set_id !== row.evidence_set_id))
      return { conflict: true as const, observation_id: null, latest: null };
    const latest = imported[0] ?? null;
    const grade = latest ? await trx.selectFrom("observation.grade_observation").select("observation_id")
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("execution_id", "=", latest.execution_id).executeTakeFirst() : null;
    return { conflict: false as const, observation_id: grade?.observation_id ?? null, latest };
  });
  if (previous.conflict) return failure(score.id, "queue item was imported for a different pinned target");
  if (previous.latest && previous.latest.attempt_id !== attempt_label
    && Number(previous.latest.attempt_id.split(":")[1]) > Date.parse(score.updatedAt))
    return failure(score.id, "older annotation revision cannot replace a newer one");
  const evidence: EvidenceSet = { evidence_set_id: pinned.evidence.evidence_set_id as EvidenceSetId,
    references: pinned.evidence.evidence_refs as unknown as EvidenceSet["references"],
    is_incomplete: pinned.evidence.is_incomplete, incompleteness_reason: pinned.evidence.incompleteness_reason };
  const registered = await registerGradingContext(db, tenant, { question, evidence, evaluator: HUMAN_EVALUATOR });
  if (!registered.ok) return failure(score.id, registered.error.detail);
  const details: GradeDetails = { answer: answer.value, probabilities: null, confidence: null,
    normalized_score: null, decision_policy_id: null, decision_policy_version: null,
    reviewer_id: score.authorUserId, reviewer_details: { source: "langfuse", action: previous.latest ? "revision" : "create",
      score_id: score.id, queue_item_id: input.queue_item_id, score_timestamp: score.timestamp,
      updated_at: score.updatedAt }, comments: input.allow_notes ? score.comment ?? null : null,
    rationale: null, quality_flags: [],
    supersedes_observation_id: previous.latest?.attempt_id === attempt_label ? null
      : previous.observation_id as GradeObservationId | null };
  const accepted = await acceptHumanGrade(db, tenant, { subject_occurrence_id: row.occurrence_id as ItemOccurrenceId,
    evidence_set_id: row.evidence_set_id as EvidenceSetId, question_id: row.question_id as QuestionId,
    question_version: row.question_version, evaluator_definition_id: HUMAN_EVALUATOR.evaluator_definition_id,
    config_digest: HUMAN_EVALUATOR.config_digest, attempt_label, details });
  if (!accepted.ok || !accepted.value.observation) return failure(score.id, accepted.ok ? "human grade has no observation" : accepted.error.detail);
  const mapped = await upsertLangfuseMapping(db, tenant, { base_mapping_key: input.mapping_key,
    occurrence_id: row.occurrence_id as ItemOccurrenceId, evidence_set_id: row.evidence_set_id as EvidenceSetId,
    evidence_set_digest: row.evidence_set_digest as CanonicalDigest, question_id: row.question_id as QuestionId,
    question_version: row.question_version, projection_version: row.projection_version,
    execution_id: accepted.value.execution.execution_id as ExecutionId, attempt_id: attempt_label,
    external_ids: { trace_id: row.trace_id as never, observation_id: row.observation_id as never,
      score_id: score.id as never, queue_item_id: input.queue_item_id as never } });
  if (!mapped.ok) return mapped;
  return ok({ observation_id: accepted.value.observation.observation_id,
    mapping_key: mapped.value.mapping_key, score_id: score.id,
    queue_item_id: input.queue_item_id, was_replay: accepted.value.was_replay });
}
