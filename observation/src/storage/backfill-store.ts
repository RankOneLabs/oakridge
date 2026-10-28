import { sql } from "kysely";
import { canonicalDigest, canonicalJson } from "../canonical/canonical-json";
import type { JsonValue } from "../domain/primitives";
import type { SourceEventOutcome } from "../ingest/cursor";
import { issueId, type ExtractionIssue } from "../projection/issues";
import { withTenant, type Database, type DatabaseTransaction, type TenantScope } from "./database";

export type BackfillPosition = { readonly source: "review_decision" | "collaboration_thread";
  readonly created_at: string; readonly id: string } | { readonly source: "done" };
export interface BackfillCounts { readonly review_decision: { readonly active: number; readonly archived: number };
  readonly collaboration_thread: { readonly active: number; readonly archived: number } }
export interface BackfillCheckpoint { readonly position: BackfillPosition; readonly counts: BackfillCounts }
export interface BackfillDelivery extends BackfillCheckpoint { readonly previous: BackfillPosition;
  readonly outcome: SourceEventOutcome | null; readonly replay?: boolean }
const INITIAL: BackfillCheckpoint = { position: { source: "review_decision", created_at: new Date(0).toISOString(), id: "" },
  counts: { review_decision: { active: 0, archived: 0 }, collaboration_thread: { active: 0, archived: 0 } } };
const digest = (value: JsonValue): string => {
  const result = canonicalDigest(value);
  if (!result.ok) throw new Error(result.error.detail);
  return result.value;
};
const json = (value: JsonValue) => sql<JsonValue>`${JSON.stringify(value)}::jsonb`;
const scope = (tenant: TenantScope): TenantScope => ({ producer: tenant.producer, namespace: tenant.namespace });

/** Both live and historical human decisions enter this exact L2 writer. */
export async function storeHumanGradeInTransaction(trx: DatabaseTransaction, tenant: TenantScope,
  outcome: Extract<SourceEventOutcome, { kind: "human_grade" }>): Promise<void> {
  const revision = await trx.selectFrom("observation.source_revision").select(["revision_id", "run_id"])
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("revision_id", "=", outcome.target).executeTakeFirst();
  if (!revision || revision.run_id !== outcome.run_id) throw new Error(`target revision ${outcome.target} is not captured`);
  const occurrences = await trx.selectFrom("observation.item_occurrence")
    .select(["occurrence_id", "item_kind"]).where("producer", "=", tenant.producer)
    .where("namespace", "=", tenant.namespace).where("revision_id", "=", outcome.target).execute();
  const evaluator_definition_id = "oakridge-operator-human";
  const config_digest = "oakridge-operator/v1";
  await trx.insertInto("observation.evaluator_definition").values({ ...scope(tenant), evaluator_definition_id,
    kind: "human", backend_kind: "local", provider: "oakridge", model: null,
    prompt_digest: "oakridge-review/v1", config_digest, runtime_revision: "1",
    cost_metadata: null, seed: null, attempt_controls: null,
    identity_digest: digest(["oakridge", "operator", "human", "1"]) })
    .onConflict((conflict) => conflict.columns(["producer", "namespace", "evaluator_definition_id"]).doNothing()).execute();
  for (const item of occurrences) {
    const question_id = `oakridge-review:${outcome.review}:${item.item_kind}`;
    const question_version = "1";
    const evidence_set_id = digest(["oakridge-review-evidence", outcome.target, item.occurrence_id]);
    const execution_id = digest(["oakridge-review-execution", outcome.event_id, item.occurrence_id]);
    const observation_id = digest(["oakridge-review-observation", outcome.event_id, item.occurrence_id]);
    const idempotency_digest = digest(["oakridge-review", outcome.event_id, item.occurrence_id]);
    await trx.insertInto("observation.question_definition").values({ ...scope(tenant), question_id, question_version,
      target_item_kinds: json([item.item_kind]), input_recipe: json({ source: "oakridge.review_decision" }),
      response_kind: "structured", allowed_values: null, missing_evidence_policy: "abstain",
      abstain_semantics: "missing source revision", unclear_semantics: "ambiguous review",
      interpretation_caveats: "operator decision on an artifact revision", requires_repository_snapshot: false })
      .onConflict((conflict) => conflict.columns(["producer", "namespace", "question_id", "question_version"]).doNothing()).execute();
    await trx.insertInto("observation.evidence_set").values({ ...scope(tenant), evidence_set_id,
      evidence_refs: json([{ revision_id: outcome.target, occurrence_id: item.occurrence_id }]),
      is_incomplete: false, incompleteness_reason: null })
      .onConflict((conflict) => conflict.columns(["producer", "namespace", "evidence_set_id"]).doNothing()).execute();
    await trx.insertInto("observation.evaluation_execution").values({ ...scope(tenant), execution_id,
      subject_occurrence_id: item.occurrence_id, evidence_set_id, question_id, question_version,
      evaluator_definition_id, config_digest, attempt_label: outcome.event_id, idempotency_digest,
      started_at: new Date(outcome.decided_at), ended_at: new Date(outcome.decided_at), status: "completed",
      error: null, model_usage: null, cost: null, external_execution_id: null,
      provider_link: null, reproducibility_metadata: null })
      .onConflict((conflict) => conflict.columns(["producer", "namespace", "execution_id"]).doNothing()).execute();
    const answer = { kind: "structured", state: "answered", value: { review: outcome.review,
      decision: outcome.decision, effect: outcome.effect, feedback: outcome.feedback as JsonValue } } as const;
    await trx.insertInto("observation.grade_observation").values({ ...scope(tenant), observation_id, execution_id,
      subject_occurrence_id: item.occurrence_id, evidence_set_id, question_id, question_version,
      evaluator_definition_id, answer_kind: "structured", answer_state: "answered",
      answer_payload: json(answer), probabilities: null, confidence: null, normalized_score: null,
      decision_policy_id: null, decision_policy_version: null, reviewer_id: "oakridge-operator",
      reviewer_details: json({ review: outcome.review, decision: outcome.decision, effect: outcome.effect }),
      comments: null, rationale: null, quality_flags: json([]), supersedes_observation_id: null,
      recorded_at: new Date(outcome.decided_at) })
      .onConflict((conflict) => conflict.columns(["producer", "namespace", "observation_id"]).doNothing()).execute();
  }
}

async function storeCollaboration(trx: DatabaseTransaction, tenant: TenantScope,
  outcome: Extract<SourceEventOutcome, { kind: "collaboration_thread" }>): Promise<void> {
  const revision_id = outcome.revision_id;
  if (revision_id) {
    const revision = await trx.selectFrom("observation.source_revision").select("run_id")
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("revision_id", "=", revision_id).executeTakeFirst();
    if (!revision || revision.run_id !== outcome.run_id) throw new Error(`thread revision ${revision_id} is not captured`);
  }
  const candidates = revision_id && outcome.context.anchor !== null
    ? await trx.selectFrom("observation.item_occurrence").select("occurrence_id")
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("revision_id", "=", revision_id).where("json_pointer", "=", outcome.context.anchor).execute() : [];
  const occurrence_id = candidates.length === 1 ? candidates[0]!.occurrence_id : null;
  if (revision_id && outcome.context.anchor !== null && occurrence_id === null) {
    const issue: ExtractionIssue = { revision_id, extractor_id: "oakridge-collaboration-anchor",
      extractor_version: "1", item_selector: outcome.context.anchor, kind: "unresolved_relation",
      detail: `thread ${outcome.event_id} anchor resolves to no unique occurrence`, is_retriable: true };
    await trx.insertInto("observation.extraction_issue").values({ ...scope(tenant), issue_id: issueId(issue), ...issue })
      .onConflict((conflict) => conflict.columns(["producer", "namespace", "issue_id"]).doNothing()).execute();
  }
  for (const message of outcome.messages) await trx.insertInto("observation.source_collaboration_comment").values({ ...scope(tenant),
    message_id: message.id, thread_id: outcome.event_id, run_id: outcome.run_id, unit_id: outcome.unit,
    revision_id, anchor: outcome.context.anchor, title: outcome.context.title,
    body: json(message.body), occurrence_id, recorded_at: new Date(message.created_at) })
    .onConflict((conflict) => conflict.columns(["producer", "namespace", "message_id"]).doNothing()).execute();
}

export function readBackfillCheckpoint(db: Database, tenant: TenantScope): Promise<BackfillCheckpoint> {
  return withTenant(db, tenant, async (trx) => {
    const row = await trx.selectFrom("observation.source_backfill_position").select(["position", "counts"])
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace).executeTakeFirst();
    return row ? { position: row.position as unknown as BackfillPosition,
      counts: row.counts as unknown as BackfillCounts } : INITIAL;
  });
}

export async function deliverBackfill(db: Database, tenant: TenantScope, delivery: BackfillDelivery): Promise<"accepted" | "conflict"> {
  return withTenant(db, tenant, async (trx) => {
    await trx.insertInto("observation.source_backfill_position").values({ ...scope(tenant),
      position: json(INITIAL.position), counts: json(INITIAL.counts as unknown as JsonValue), updated_at: new Date() })
      .onConflict((conflict) => conflict.columns(["producer", "namespace"]).doNothing()).execute();
    const row = await sql<{ position: BackfillPosition }>`SELECT position FROM observation.source_backfill_position
      WHERE producer = ${tenant.producer} AND namespace = ${tenant.namespace} FOR UPDATE`.execute(trx);
    const current = canonicalJson(row.rows[0]?.position as unknown as JsonValue);
    const previous = canonicalJson(delivery.previous);
    if (!delivery.replay && (!current.ok || !previous.ok || current.value !== previous.value)) return "conflict";
    const outcome = delivery.outcome;
    if (outcome?.kind === "human_grade") {
      await storeHumanGradeInTransaction(trx, tenant, outcome);
      await trx.insertInto("observation.source_event_outcome").values({ ...scope(tenant),
        event_id: outcome.event_id, run_id: outcome.run_id, commit_txid: 0,
        event_kind: outcome.event_kind, outcome_kind: outcome.kind, detail: json(outcome as unknown as JsonValue) })
        .onConflict((conflict) => conflict.columns(["producer", "namespace", "event_id"]).doNothing()).execute();
      await trx.insertInto("observation.source_human_grade").values({ ...scope(tenant), event_id: outcome.event_id,
        run_id: outcome.run_id, unit_id: outcome.unit, review: outcome.review, decision: outcome.decision,
        target_revision_id: outcome.target, evaluator_kind: "human", feedback: json(outcome.feedback as JsonValue) })
        .onConflict((conflict) => conflict.columns(["producer", "namespace", "event_id"]).doNothing()).execute();
    }
    if (outcome?.kind === "collaboration_thread") await storeCollaboration(trx, tenant, outcome);
    if (!delivery.replay) await trx.updateTable("observation.source_backfill_position").set({ position: json(delivery.position),
      counts: json(delivery.counts as unknown as JsonValue), updated_at: new Date() })
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace).execute();
    return "accepted";
  });
}
