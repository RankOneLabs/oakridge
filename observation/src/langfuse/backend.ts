import { z } from "zod";
import { err, ok, type JsonValue, type Result } from "../domain/primitives";
import type { CanonicalDigest } from "../domain/identity";
import type { EvaluationBackend, ExternalTargetIds, FetchSelector, InboundEvaluation, LangfuseError,
  LangfuseScore, ProjectionInput, ReconcileOutcome, ReconcileSelector } from "../ports/evaluation-backend";
import { withTenant, type Database, type TenantScope } from "../storage/database";
import { placeLangfuseInboundScore, quarantineLangfuseInbound, transitionLangfuseMapping,
  upsertLangfuseMapping } from "../storage/langfuse-store";
import { detectLangfuseFeatures, requireLangfuseCapability } from "./feature-detection";
import type { LangfuseConfig } from "./config";
import { withBoundedRetry, type LangfuseHttpClient } from "./http-client";
import { mappingKey } from "./mapping";
import { encodeProjection } from "./projection";
import { reconcileLangfuseMapping } from "./reconcile";

const scoreSchema = z.object({
  id: z.string().min(1), projectId: z.string().min(1), name: z.string().min(1),
  value: z.union([z.number(), z.string(), z.boolean()]),
  dataType: z.enum(["NUMERIC", "BOOLEAN", "CATEGORICAL", "TEXT", "CORRECTION"]),
  source: z.string().min(1), updatedAt: z.string().min(1),
  comment: z.string().nullable().optional(),
  queueId: z.string().nullable().optional(), authorUserId: z.string().nullable().optional(),
  subject: z.object({ kind: z.literal("observation"), id: z.string(), traceId: z.string() }),
  metadata: z.object({ mapping_key: z.string(), evaluator_definition_id: z.string(),
    model: z.string().nullable(), grader_source: z.string() }).optional(),
});
const scoresSchema = z.object({ data: z.array(z.json()) });
const queueSchema = z.object({ id: z.string(), queueId: z.string(), objectId: z.string(),
  objectType: z.enum(["TRACE", "OBSERVATION", "SESSION"]), status: z.enum(["PENDING", "COMPLETED"]),
  completedAt: z.string().nullable().optional() });

type RemoteScore = z.infer<typeof scoreSchema>;

function failure(operation: string, entity_id: string, detail: string): Result<never, LangfuseError> {
  return err({ operation, entity_id, detail });
}

/** No target is written until the deployment has completed Phase A validation. */
export class LangfuseBackend implements EvaluationBackend {
  constructor(private readonly db: Database, private readonly tenant: TenantScope,
    private readonly config: LangfuseConfig, private readonly client: LangfuseHttpClient) {}

  async project(input: ProjectionInput): Promise<Result<ExternalTargetIds, LangfuseError>> {
    const shape = encodeProjection(input);
    if (!shape.ok) return shape;
    const digest = mappingKey({ occurrence_id: input.execution.subject_occurrence_id, evidence: input.evidence,
      question_id: input.question.question_id, question_version: input.question.question_version,
      projection_version: input.projection_version });
    if (!digest.ok) return digest;
    const row = await upsertLangfuseMapping(this.db, this.tenant, {
      base_mapping_key: digest.value.mapping_key, occurrence_id: input.execution.subject_occurrence_id,
      evidence_set_id: input.evidence.evidence_set_id, evidence_set_digest: digest.value.evidence_set_digest,
      question_id: input.question.question_id, question_version: input.question.question_version,
      projection_version: input.projection_version, execution_id: input.execution.execution_id,
      attempt_id: input.execution.attempt_label, external_ids: null,
    });
    if (!row.ok) return row;
    if (row.value.trace_id && row.value.observation_id && row.value.score_id && row.value.queue_item_id)
      return ok({ trace_id: row.value.trace_id as ExternalTargetIds["trace_id"],
        observation_id: row.value.observation_id as ExternalTargetIds["observation_id"],
        score_id: row.value.score_id as ExternalTargetIds["score_id"],
        queue_item_id: row.value.queue_item_id as ExternalTargetIds["queue_item_id"] });
    const key = row.value.mapping_key as CanonicalDigest;
    const pending = await transitionLangfuseMapping(this.db, this.tenant, key, "pending");
    if (!pending.ok) return pending;
    const features = await detectLangfuseFeatures(this.client, this.config);
    if (!features.ok) return failure("project", key, `${features.error.capability}: ${features.error.detail}`);
    for (const capability of ["decision_model_evaluators", "annotation_queues", "score_readback"] as const) {
      const available = requireLangfuseCapability(features.value, capability);
      if (!available.ok) return failure("project", key, `${available.error.capability}: ${available.error.detail}`);
    }
    return failure("project", key, "Phase A synthetic write and readback have not been validated on this deployment; mapping remains pending");
  }

  private async quarantine(key: CanonicalDigest, raw_payload: JsonValue, reason: string,
    score_id: string | null = null, observation_id: string | null = null): Promise<Result<void, LangfuseError>> {
    const result = await quarantineLangfuseInbound(this.db, this.tenant, { mapping_key: key,
      score_id: score_id as ExternalTargetIds["score_id"] | null,
      observation_id: observation_id as ExternalTargetIds["observation_id"] | null,
      sync_state: "unmatched", raw_payload, reason });
    return result.ok ? ok(undefined) : result;
  }

  async fetch(selector: FetchSelector): Promise<Result<InboundEvaluation, LangfuseError>> {
    const row = await withTenant(this.db, this.tenant, (trx) => trx.selectFrom("observation.langfuse_mapping")
      .selectAll().where("producer", "=", this.tenant.producer).where("namespace", "=", this.tenant.namespace)
      .where("mapping_key", "=", selector.mapping_key).executeTakeFirst());
    if (!row || row.trace_id !== selector.external_ids.trace_id || row.observation_id !== selector.external_ids.observation_id
      || row.score_id !== selector.external_ids.score_id || row.queue_item_id !== selector.external_ids.queue_item_id)
      return failure("fetch", selector.mapping_key, "mapping is not authenticated");
    const from = new Date(row.created_at.getTime() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 86_400_000).toISOString();
    const query = new URLSearchParams({ id: row.score_id, traceId: row.trace_id,
      observationId: row.observation_id, fields: "details,subject,annotation", fromTimestamp: from,
      toTimestamp: to, limit: "100" });
    const scores = await withBoundedRetry(() => this.client.request({ operation: "fetch_scores", entity_id: selector.mapping_key,
      method: "GET", path: `/api/public/v3/scores?${query}`, response: scoresSchema }), this.config.retry);
    if (!scores.ok) return scores;
    const definition = await withTenant(this.db, this.tenant, async (trx) => {
      const question = await trx.selectFrom("observation.question_definition").select(["response_kind", "allowed_values"])
        .where("producer", "=", this.tenant.producer).where("namespace", "=", this.tenant.namespace)
        .where("question_id", "=", row.question_id).where("question_version", "=", row.question_version).executeTakeFirst();
      const execution = await trx.selectFrom("observation.evaluation_execution")
        .select("evaluator_definition_id").where("producer", "=", this.tenant.producer)
        .where("namespace", "=", this.tenant.namespace).where("execution_id", "=", row.execution_id)
        .executeTakeFirst();
      const evaluator = await trx.selectFrom("observation.evaluator_definition").select(["model"])
        .where("producer", "=", this.tenant.producer).where("namespace", "=", this.tenant.namespace)
        .where("evaluator_definition_id", "=", execution?.evaluator_definition_id ?? "").executeTakeFirst();
      return { question, evaluator, evaluator_id: execution?.evaluator_definition_id ?? null };
    });
    const authenticated: LangfuseScore[] = [];
    for (const raw of scores.value.data) {
      const parsed = scoreSchema.safeParse(raw);
      if (!parsed.success) {
        const quarantined = await this.quarantine(selector.mapping_key, raw, "score response has an invalid shape");
        if (!quarantined.ok) return quarantined;
        continue;
      }
      const score = parsed.data;
      const reason = score.id !== row.score_id || score.projectId !== this.config.project_id
        || score.subject.traceId !== row.trace_id || score.subject.id !== row.observation_id
        || score.name !== `${row.question_id}@${row.question_version}`
        || !score.metadata || score.metadata.mapping_key !== row.mapping_key
        || score.metadata.evaluator_definition_id !== definition.evaluator_id
        || score.metadata.model !== (definition.evaluator?.model ?? null)
        || score.metadata.grader_source !== score.source
        || !definition.question || !valueInDomain(score.value, score.dataType,
          definition.question.response_kind, definition.question.allowed_values)
        ? "score identifiers, question, domain, model, evaluator or grader source do not authenticate" : null;
      if (reason) {
        const quarantined = await this.quarantine(selector.mapping_key, raw, reason, score.id, score.subject.id);
        if (!quarantined.ok) return quarantined;
        continue;
      }
      const placement = await placeLangfuseInboundScore(this.db, this.tenant, { mapping_key: selector.mapping_key,
        score_id: score.id as ExternalTargetIds["score_id"],
        observation_id: score.subject.id as ExternalTargetIds["observation_id"], raw_payload: score as JsonValue });
      if (!placement.ok || placement.value.status !== "mapped") continue;
      authenticated.push({ score_id: score.id as ExternalTargetIds["score_id"],
        observation_id: score.subject.id as ExternalTargetIds["observation_id"], name: score.name,
        value: score.value, comment: score.comment ?? null, updated_at: score.updatedAt });
    }
    const queue_id = this.config.annotation_queue_id;
    if (!queue_id) return ok({ scores: authenticated, annotation_outcomes: [] });
    const queue_item_id = row.queue_item_id;
    if (!queue_item_id) return failure("fetch_annotation", selector.mapping_key, "mapping has no queue item ID");
    const queue = await withBoundedRetry(() => this.client.request({ operation: "fetch_annotation", entity_id: selector.mapping_key,
      method: "GET", path: `/api/public/annotation-queues/${encodeURIComponent(queue_id)}/items/${encodeURIComponent(queue_item_id)}`,
      response: queueSchema }), this.config.retry);
    if (!queue.ok) return queue;
    if (queue.value.id !== row.queue_item_id || queue.value.queueId !== this.config.annotation_queue_id
      || queue.value.objectType !== "OBSERVATION" || queue.value.objectId !== row.observation_id)
      return failure("fetch_annotation", selector.mapping_key, "queue item is not authenticated");
    if (queue.value.status === "COMPLETED" && queue.value.completedAt) {
      const annotationQuery = new URLSearchParams({ traceId: row.trace_id, observationId: row.observation_id,
        queueId: queue_id, source: "ANNOTATION", fields: "details,subject,annotation", limit: "100" });
      const annotations = await withBoundedRetry(() => this.client.request({ operation: "fetch_annotation_scores",
        entity_id: selector.mapping_key, method: "GET", path: `/api/public/v3/scores?${annotationQuery}`,
        response: scoresSchema }), this.config.retry);
      if (!annotations.ok) return annotations;
      for (const raw of annotations.value.data) {
        const parsed = scoreSchema.safeParse(raw);
        if (!parsed.success) {
          const quarantined = await this.quarantine(selector.mapping_key, raw, "annotation score response has an invalid shape");
          if (!quarantined.ok) return quarantined;
          continue;
        }
        const score = parsed.data;
        if (score.queueId !== queue_id || score.source !== "ANNOTATION" || score.projectId !== this.config.project_id
          || score.subject.id !== row.observation_id || score.subject.traceId !== row.trace_id
          || score.name !== `${row.question_id}@${row.question_version}` || !definition.question
          || !valueInDomain(score.value, score.dataType, definition.question.response_kind,
            definition.question.allowed_values)) {
          const quarantined = await this.quarantine(selector.mapping_key, raw, "annotation score does not authenticate",
            score.id, score.subject.id);
          if (!quarantined.ok) return quarantined;
          continue;
        }
        return ok({ scores: authenticated, annotation_outcomes: [{ status: "completed",
          queue_item_id: queue.value.id as ExternalTargetIds["queue_item_id"],
          score_id: score.id as ExternalTargetIds["score_id"], value: score.value,
          reviewer_id: score.authorUserId ?? null, completed_at: queue.value.completedAt }] });
      }
    }
    return ok({ scores: authenticated, annotation_outcomes: [{ status: "pending",
      queue_item_id: queue.value.id as ExternalTargetIds["queue_item_id"] }] });
  }

  reconcile(selector: ReconcileSelector): Promise<Result<ReconcileOutcome, LangfuseError>> {
    return reconcileLangfuseMapping(this.db, this.tenant, selector, (input) => this.fetch(input));
  }
}

function valueInDomain(value: number | string | boolean, data_type: RemoteScore["dataType"],
  response_kind: string, allowed_values: JsonValue | null): boolean {
  if (response_kind === "boolean") return data_type === "BOOLEAN" && typeof value === "boolean";
  if (response_kind === "numeric") return data_type === "NUMERIC" && typeof value === "number" && Number.isFinite(value);
  if (response_kind === "choice" || response_kind === "ordinal")
    return data_type === "CATEGORICAL" && typeof value === "string" && Array.isArray(allowed_values)
      && allowed_values.includes(value);
  if (response_kind === "text") return data_type === "TEXT" && typeof value === "string";
  return false;
}
