import { z } from "zod";
import { err, ok, type JsonValue, type Result } from "../domain/primitives";
import type { LangfuseError } from "../ports/evaluation-backend";
import { withTenant, type Database, type TenantScope } from "../storage/database";
import { blindEvidence, type BlindedEvidencePackage } from "./blinding";
import type { EvidenceSource } from "./evidence-recipe";
import type { LangfuseHttpClient } from "./http-client";
import { evidenceSetDigest } from "./mapping";
import { upsertLangfuseMapping } from "../storage/langfuse-store";
import type { CanonicalDigest, EvidenceSetId, ExecutionId, ItemOccurrenceId, QuestionId } from "../domain/identity";
import { scoreConfigName } from "./score-config";
import { LANGFUSE_PILOT_QUESTIONS } from "../grading/catalogue/langfuse-pilot";
import { canonicalJson } from "../canonical/canonical-json";
import type { PilotQuestionId } from "./evidence-recipe";

export interface AnnotationTarget { readonly mapping_key: string; readonly sources: readonly EvidenceSource[];
  readonly graded_artifact: "report" | "code" }
export interface PinnedAnnotationTarget { readonly mapping_key: string; readonly occurrence_id: string;
  readonly evidence_set_id: string; readonly trace_id: string; readonly observation_id: string;
  readonly evidence_set_digest: string; readonly question_id: string; readonly question_version: string;
  readonly projection_version: string; readonly execution_id: string; readonly score_id: string;
  readonly response_kind: string; readonly allowed_values: readonly JsonValue[] | null;
  readonly evidence: BlindedEvidencePackage }
export interface QueuedAnnotationTarget extends PinnedAnnotationTarget { readonly queue_item_id: string }

const referenceSchema = z.object({ ref: z.string(), digest: z.string().nullable() }).passthrough();
const queueItemRequestSchema = z.object({ objectId: z.string().min(1), objectType: z.literal("OBSERVATION") });
const queueItemSchema = z.object({ id: z.string().min(1), queueId: z.string().min(1),
  objectId: z.string().min(1), objectType: z.literal("OBSERVATION"),
  status: z.enum(["PENDING", "COMPLETED"]) });
const queueSchema = z.object({ id: z.string().min(1), scoreConfigIds: z.array(z.string().min(1)) });
const configSchema = z.object({ id: z.string().min(1), name: z.string().min(1),
  dataType: z.enum(["CATEGORICAL", "BOOLEAN", "NUMERIC"]),
  categories: z.array(z.object({ label: z.string(), value: z.number() })).nullable().optional() });
const observationSchema = z.object({ data: z.array(z.object({ id: z.string(), traceId: z.string().nullable(),
  projectId: z.string(), input: z.string().nullable(), output: z.string().nullable() })) });
const remoteInputSchema = z.object({ question_text: z.string(), graded_artifact: z.enum(["report", "code"]),
  input_recipe: z.unknown(),
  evidence_set: z.object({ evidence_set_id: z.string(), evidence_refs: z.array(z.object({
    ref: z.string(), digest: z.string().nullable(), content: z.null(),
    kind: z.enum(["raw_build_output", "raw_test_output", "repository_content", "public"]).optional(),
    is_redacted: z.boolean() }).strict()), is_incomplete: z.boolean(),
    incompleteness_reason: z.string().nullable() }).strict() }).strict();
const remoteOutputSchema = z.object({ execution_id: z.string(), status: z.string(), error: z.null(),
  model_usage: z.null(), cost: z.number().nullable() }).strict();

function failure(entity_id: string, detail: string): Result<never, LangfuseError> {
  return err({ operation: "annotation_queue", entity_id, detail });
}

/** A queue item is eligible only when its remote observation points to one captured occurrence and frozen set. */
export async function resolveAnnotationTarget(db: Database, tenant: TenantScope, target: AnnotationTarget)
  : Promise<Result<PinnedAnnotationTarget, LangfuseError>> {
  return withTenant(db, tenant, async (trx) => {
    const row = await trx.selectFrom("observation.langfuse_mapping").selectAll()
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("mapping_key", "=", target.mapping_key).executeTakeFirst();
    if (!row || !row.trace_id || !row.observation_id || !row.score_id)
      return failure(target.mapping_key, "target has no pinned remote observation");
    const mapped = await trx.selectFrom("observation.langfuse_mapping")
      .select(["occurrence_id", "evidence_set_id"])
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("observation_id", "=", row.observation_id).execute();
    const pins = new Set(mapped.map((value) => `${value.occurrence_id}\0${value.evidence_set_id}`));
    if (pins.size !== 1) return failure(target.mapping_key, "remote observation resolves to multiple pinned targets");
    const occurrences = await trx.selectFrom("observation.item_occurrence").selectAll()
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("occurrence_id", "=", row.occurrence_id).execute();
    const sets = await trx.selectFrom("observation.evidence_set").selectAll()
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("evidence_set_id", "=", row.evidence_set_id).execute();
    const questions = await trx.selectFrom("observation.question_definition").selectAll()
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("question_id", "=", row.question_id).where("question_version", "=", row.question_version).execute();
    const source = occurrences[0] ? await trx.selectFrom("observation.source_revision").select("revision_id")
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("revision_id", "=", occurrences[0].revision_id).execute() : [];
    if (occurrences.length !== 1 || sets.length !== 1 || questions.length !== 1 || source.length !== 1)
      return failure(target.mapping_key, "target does not resolve to one occurrence, source revision, evidence set and question");
    const digest = evidenceSetDigest({ evidence_set_id: row.evidence_set_id as never,
      references: sets[0]!.evidence_refs as never, is_incomplete: sets[0]!.is_incomplete,
      incompleteness_reason: sets[0]!.incompleteness_reason });
    if (!digest.ok || digest.value !== row.evidence_set_digest)
      return failure(target.mapping_key, "mapping does not match the frozen evidence set");
    const refs = z.array(referenceSchema).safeParse(sets[0]!.evidence_refs);
    if (!refs.success || refs.data.length !== target.sources.length || target.sources.some((entry) =>
      refs.data.filter((ref) => ref.ref === entry.ref && ref.digest === entry.digest).length !== 1))
      return failure(target.mapping_key, "selected references differ from the frozen evidence set");
    const question = questions[0]!;
    const blinded = blindEvidence({ ...question, question_id: question.question_id as never,
      target_item_kinds: question.target_item_kinds as string[], input_recipe: question.input_recipe as never,
      response_kind: question.response_kind as never, allowed_values: question.allowed_values as never,
      missing_evidence_policy: question.missing_evidence_policy as never }, target.sources, target.graded_artifact);
    if (!blinded.ok) return failure(target.mapping_key, blinded.error.detail);
    return ok({ mapping_key: target.mapping_key, occurrence_id: row.occurrence_id,
      evidence_set_id: row.evidence_set_id, trace_id: row.trace_id,
      observation_id: row.observation_id, evidence_set_digest: row.evidence_set_digest,
      question_id: row.question_id, question_version: row.question_version,
      projection_version: row.projection_version, execution_id: row.execution_id, score_id: row.score_id,
      response_kind: question.response_kind, allowed_values: question.allowed_values as readonly JsonValue[] | null,
      evidence: blinded.value });
  });
}

export async function queueAnnotationTarget(db: Database, tenant: TenantScope, client: LangfuseHttpClient,
  queue_id: string, target: AnnotationTarget): Promise<Result<QueuedAnnotationTarget, LangfuseError>> {
  if (!queue_id) return failure(target.mapping_key, "annotation queue is not configured");
  const pinned = await resolveAnnotationTarget(db, tenant, target);
  if (!pinned.ok) return pinned;
  const queue = await client.request({ operation: "read_annotation_queue", entity_id: queue_id,
    method: "GET", path: `/api/public/annotation-queues/${encodeURIComponent(queue_id)}`, response: queueSchema });
  if (!queue.ok) return queue;
  if (queue.value.id !== queue_id) return failure(target.mapping_key, "configured queue ID differs from the remote queue");
  let matchingConfigs = 0;
  for (const config_id of queue.value.scoreConfigIds) {
    const remoteConfig = await client.request({ operation: "read_annotation_score_config", entity_id: config_id,
      method: "GET", path: `/api/public/score-configs/${encodeURIComponent(config_id)}`, response: configSchema });
    if (!remoteConfig.ok) return remoteConfig;
    const isCategorical = ["choice", "ordinal"].includes(pinned.value.response_kind);
    const matchesDomain = isCategorical
      ? remoteConfig.value.dataType === "CATEGORICAL"
        && JSON.stringify(remoteConfig.value.categories?.map((category) => category.label)) === JSON.stringify(pinned.value.allowed_values)
      : pinned.value.response_kind === "boolean" && remoteConfig.value.dataType === "BOOLEAN";
    if (remoteConfig.value.id === config_id && remoteConfig.value.name ===
      scoreConfigName(pinned.value.question_id, pinned.value.question_version) && matchesDomain) matchingConfigs++;
  }
  if (matchingConfigs !== 1) return failure(target.mapping_key, "queue must contain exactly one config for the pinned question");
  const filter = JSON.stringify([{ type: "string", column: "id", operator: "=", value: pinned.value.observation_id }]);
  const params = new URLSearchParams({ filter, fields: "io,basic", limit: "2" });
  const remote = await client.request({ operation: "read_blinded_observation", entity_id: pinned.value.observation_id,
    method: "GET", path: `/api/public/v2/observations?${params}`, response: observationSchema });
  if (!remote.ok) return remote;
  if (remote.value.data.length !== 1 || remote.value.data[0]!.id !== pinned.value.observation_id
    || remote.value.data[0]!.traceId !== pinned.value.trace_id)
    return failure(target.mapping_key, "remote observation does not resolve uniquely to the pinned trace");
  const observation = remote.value.data[0]!;
  let rawInput: unknown; let rawOutput: unknown;
  try { rawInput = JSON.parse(observation.input ?? ""); rawOutput = JSON.parse(observation.output ?? ""); }
  catch { return failure(target.mapping_key, "remote observation IO is not structured JSON"); }
  const input = remoteInputSchema.safeParse(rawInput);
  const output = remoteOutputSchema.safeParse(rawOutput);
  const pilot = LANGFUSE_PILOT_QUESTIONS[pinned.value.question_id as PilotQuestionId];
  const expectedRecipe = pilot ? canonicalJson(pilot.definition.input_recipe) : null;
  const actualRecipe = input.success ? canonicalJson(input.data.input_recipe) : null;
  const references = input.success ? input.data.evidence_set.evidence_refs : [];
  if (!input.success || !output.success || !pilot || !expectedRecipe?.ok || !actualRecipe?.ok
    || expectedRecipe.value !== actualRecipe.value || input.data.question_text !== pilot.text
    || input.data.graded_artifact !== target.graded_artifact
    || input.data.evidence_set.evidence_set_id !== pinned.value.evidence_set_id
    || references.length !== target.sources.length
    || target.sources.some((source) => references.filter((ref) => ref.ref === source.ref && ref.digest === source.digest).length !== 1))
    return failure(target.mapping_key, "remote observation exposes content or differs from the blinded evidence package");
  const body = queueItemRequestSchema.safeParse({ objectId: pinned.value.observation_id, objectType: "OBSERVATION" });
  if (!body.success) return failure(target.mapping_key, "queue item body is invalid");
  const path = `/api/public/annotation-queues/${encodeURIComponent(queue_id)}/items`;
  const created = await client.request({ operation: "create_annotation_queue_item", entity_id: target.mapping_key,
    method: "POST", path, body: body.data, response: queueItemSchema });
  if (!created.ok) return created;
  const verified = await client.request({ operation: "verify_annotation_queue_item", entity_id: created.value.id,
    method: "GET", path: `${path}/${encodeURIComponent(created.value.id)}`, response: queueItemSchema });
  if (!verified.ok) return verified;
  if (verified.value.id !== created.value.id || verified.value.queueId !== queue_id
    || verified.value.objectId !== pinned.value.observation_id || verified.value.objectType !== "OBSERVATION")
    return failure(target.mapping_key, "created queue item does not resolve to the pinned observation");
  const again = await resolveAnnotationTarget(db, tenant, target);
  if (!again.ok || again.value.observation_id !== pinned.value.observation_id)
    return failure(target.mapping_key, "queue target pins changed during creation");
  const claim = await upsertLangfuseMapping(db, tenant, { base_mapping_key: target.mapping_key as CanonicalDigest,
    occurrence_id: pinned.value.occurrence_id as ItemOccurrenceId,
    evidence_set_id: pinned.value.evidence_set_id as EvidenceSetId,
    evidence_set_digest: pinned.value.evidence_set_digest as CanonicalDigest,
    question_id: pinned.value.question_id as QuestionId, question_version: pinned.value.question_version,
    projection_version: pinned.value.projection_version,
    execution_id: pinned.value.execution_id as ExecutionId, attempt_id: `queue:${verified.value.id}`,
    external_ids: { trace_id: pinned.value.trace_id as never, observation_id: pinned.value.observation_id as never,
      score_id: pinned.value.score_id as never, queue_item_id: verified.value.id as never } });
  if (!claim.ok) return claim;
  return ok({ ...pinned.value, queue_item_id: verified.value.id });
}
