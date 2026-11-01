import { sql } from "kysely";
import { canonicalDigest, canonicalJson } from "../canonical/canonical-json";
import type { JsonValue } from "../domain/primitives";
import type { SourceEventOutcome } from "../ingest/cursor";
import { issueId, type ExtractionIssue } from "../projection/issues";
import { jsonText, withTenant, type Database, type DatabaseTransaction, type TenantScope } from "./database";

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
const scope = (tenant: TenantScope): TenantScope => ({ producer: tenant.producer, namespace: tenant.namespace });
/** Verify a natural-key replay against every supplied content column. */
export function verifyStored(table: string, expected: object, stored: object | undefined, jsonColumns: readonly string[] = []): void {
  if (!stored) throw new Error(`${table} disappeared during replay`);
  for (const [column, value] of Object.entries(expected)) {
    const decoded = jsonColumns.includes(column) && value !== null ? JSON.parse(value as string) : value;
    const normalize = (input: unknown): JsonValue => input instanceof Date ? input.toISOString() : input as JsonValue;
    const left = canonicalJson(normalize(decoded));
    const right = canonicalJson(normalize((stored as { [key: string]: unknown })[column]));
    if (!left.ok || !right.ok || left.value !== right.value)
      throw new Error(`${table} content conflict at ${column}`);
  }
}

/**
 * What became of a human decision's L2 grades. A decision on a revision published
 * before capture began has nothing to grade: its source row is kept, no grade is
 * derived, and delivery moves on rather than blocking every later event.
 */
export type HumanGradeStorage = { readonly kind: "graded" } | { readonly kind: "target_not_captured" };

/** Both live and historical human decisions enter this exact L2 writer. */
export async function storeHumanGradeInTransaction(trx: DatabaseTransaction, tenant: TenantScope,
  outcome: Extract<SourceEventOutcome, { kind: "human_grade" }>): Promise<HumanGradeStorage> {
  const revision = await trx.selectFrom("observation.source_revision").select(["revision_id", "run_id"])
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("revision_id", "=", outcome.target).executeTakeFirst();
  if (!revision) {
    console.warn("[observation] human grade target not captured", { ...scope(tenant), event_id: outcome.event_id,
      run_id: outcome.run_id, target: outcome.target });
    return { kind: "target_not_captured" };
  }
  if (revision.run_id !== outcome.run_id)
    throw new Error(`target revision ${outcome.target} belongs to run ${revision.run_id}, not ${outcome.run_id}`);
  const occurrences = await trx.selectFrom("observation.item_occurrence")
    .select(["occurrence_id", "item_kind"]).where("producer", "=", tenant.producer)
    .where("namespace", "=", tenant.namespace).where("revision_id", "=", outcome.target).execute();
  const evaluator_definition_id = "oakridge-operator-human";
  const config_digest = "oakridge-operator/v1";
  const evaluator = { ...scope(tenant), evaluator_definition_id,
    kind: "human", backend_kind: "local", provider: "oakridge", model: null,
    prompt_digest: digest("oakridge-review/v1"), instruction_text: "oakridge-review/v1", config_digest, runtime_revision: "1",
    cost_metadata: null, seed: null, attempt_controls: null,
    identity_digest: digest(["oakridge", "operator", "human", "1"]) } as const;
  const insertedEvaluator = await trx.insertInto("observation.evaluator_definition").values(evaluator)
    .onConflict((conflict) => conflict.columns(["producer", "namespace", "evaluator_definition_id"]).doNothing())
    .returning("evaluator_definition_id").executeTakeFirst();
  if (!insertedEvaluator) verifyStored("evaluator_definition", evaluator, await trx.selectFrom("observation.evaluator_definition")
    .selectAll().where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("evaluator_definition_id", "=", evaluator_definition_id).executeTakeFirst());
  for (const item of occurrences) {
    const question_id = `oakridge-review:${outcome.review}:${item.item_kind}`;
    const question_version = "1";
    const evidence_set_id = digest(["oakridge-review-evidence", outcome.target, item.occurrence_id]);
    const decision_key = outcome.decision_id ?? outcome.event_id;
    const execution_id = digest(["oakridge-review-execution", decision_key, item.occurrence_id]);
    const observation_id = digest(["oakridge-review-observation", decision_key, item.occurrence_id]);
    const idempotency_digest = digest(["oakridge-review", decision_key, item.occurrence_id]);
    const question = { ...scope(tenant), question_id, question_version,
      target_item_kinds: jsonText([item.item_kind]), input_recipe: jsonText({ source: "oakridge.review_decision" }),
      response_kind: "structured", allowed_values: null, missing_evidence_policy: "abstain",
      abstain_semantics: "missing source revision", unclear_semantics: "ambiguous review",
      interpretation_caveats: "operator decision on an artifact revision", requires_repository_snapshot: false } as const;
    const insertedQuestion = await trx.insertInto("observation.question_definition").values(question)
      .onConflict((conflict) => conflict.columns(["producer", "namespace", "question_id", "question_version"]).doNothing())
      .returning("question_id").executeTakeFirst();
    if (!insertedQuestion) verifyStored("question_definition", question, await trx.selectFrom("observation.question_definition")
      .selectAll().where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("question_id", "=", question_id).where("question_version", "=", question_version).executeTakeFirst(),
      ["target_item_kinds", "input_recipe", "allowed_values"]);
    const evidence = { ...scope(tenant), evidence_set_id,
      evidence_refs: jsonText([{ revision_id: outcome.target, occurrence_id: item.occurrence_id }]),
      is_incomplete: false, incompleteness_reason: null } as const;
    const insertedEvidence = await trx.insertInto("observation.evidence_set").values(evidence)
      .onConflict((conflict) => conflict.columns(["producer", "namespace", "evidence_set_id"]).doNothing())
      .returning("evidence_set_id").executeTakeFirst();
    if (!insertedEvidence) verifyStored("evidence_set", evidence, await trx.selectFrom("observation.evidence_set")
      .selectAll().where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("evidence_set_id", "=", evidence_set_id).executeTakeFirst(), ["evidence_refs"]);
    const execution = { ...scope(tenant), execution_id,
      subject_occurrence_id: item.occurrence_id, evidence_set_id, question_id, question_version,
      evaluator_definition_id, config_digest, attempt_label: decision_key, idempotency_digest,
      started_at: new Date(outcome.decided_at), ended_at: new Date(outcome.decided_at), status: "completed",
      error: null, model_usage: null, cost: null, external_execution_id: null,
      provider_link: null, reproducibility_metadata: null } as const;
    const insertedExecution = await trx.insertInto("observation.evaluation_execution").values(execution)
      .onConflict((conflict) => conflict.columns(["producer", "namespace", "execution_id"]).doNothing())
      .returning("execution_id").executeTakeFirst();
    if (!insertedExecution) verifyStored("evaluation_execution", execution, await trx.selectFrom("observation.evaluation_execution")
      .selectAll().where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("execution_id", "=", execution_id).executeTakeFirst());
    const answer = { kind: "structured", state: "answered", value: { review: outcome.review,
      decision: outcome.decision, effect: outcome.effect, feedback: outcome.feedback as JsonValue } } as const;
    const grade = { ...scope(tenant), observation_id, execution_id,
      subject_occurrence_id: item.occurrence_id, evidence_set_id, question_id, question_version,
      evaluator_definition_id, answer_kind: "structured", answer_state: "answered",
      answer_payload: jsonText(answer), probabilities: null, confidence: null, normalized_score: null,
      decision_policy_id: null, decision_policy_version: null, reviewer_id: "oakridge-operator",
      reviewer_details: jsonText({ review: outcome.review, decision: outcome.decision, effect: outcome.effect }),
      comments: null, rationale: null, quality_flags: jsonText([]), supersedes_observation_id: null,
      recorded_at: new Date(outcome.decided_at) } as const;
    const insertedGrade = await trx.insertInto("observation.grade_observation").values(grade)
      .onConflict((conflict) => conflict.columns(["producer", "namespace", "observation_id"]).doNothing())
      .returning("observation_id").executeTakeFirst();
    if (!insertedGrade) verifyStored("grade_observation", grade, await trx.selectFrom("observation.grade_observation")
      .selectAll().where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("observation_id", "=", observation_id).executeTakeFirst(),
      ["answer_payload", "probabilities", "reviewer_details", "quality_flags"]);
  }
  return { kind: "graded" };
}

export async function storeCollaborationInTransaction(trx: DatabaseTransaction, tenant: TenantScope,
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
  for (const message of outcome.messages) {
    const comment = { ...scope(tenant), message_id: message.id, thread_id: outcome.event_id,
      run_id: outcome.run_id, unit_id: outcome.unit, revision_id, anchor: outcome.context.anchor,
      title: outcome.context.title, body: jsonText(message.body), occurrence_id,
      recorded_at: new Date(message.created_at) } as const;
    const inserted = await trx.insertInto("observation.source_collaboration_comment").values(comment)
      .onConflict((conflict) => conflict.columns(["producer", "namespace", "message_id"]).doNothing())
      .returning("message_id").executeTakeFirst();
    if (!inserted) verifyStored("source_collaboration_comment", comment,
      await trx.selectFrom("observation.source_collaboration_comment").selectAll()
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("message_id", "=", message.id).executeTakeFirst(), ["body"]);
  }
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
      position: jsonText(INITIAL.position), counts: jsonText(INITIAL.counts as unknown as JsonValue), updated_at: new Date() })
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
        event_kind: outcome.event_kind, outcome_kind: outcome.kind, detail: jsonText(outcome as unknown as JsonValue) })
        .onConflict((conflict) => conflict.columns(["producer", "namespace", "event_id"]).doNothing()).execute();
      await trx.insertInto("observation.source_human_grade").values({ ...scope(tenant), event_id: outcome.event_id,
        run_id: outcome.run_id, unit_id: outcome.unit, review: outcome.review, decision: outcome.decision,
        target_revision_id: outcome.target, evaluator_kind: "human", feedback: jsonText(outcome.feedback as JsonValue) })
        .onConflict((conflict) => conflict.columns(["producer", "namespace", "event_id"]).doNothing()).execute();
    }
    if (outcome?.kind === "collaboration_thread") await storeCollaborationInTransaction(trx, tenant, outcome);
    if (!delivery.replay) await trx.updateTable("observation.source_backfill_position").set({ position: jsonText(delivery.position),
      counts: jsonText(delivery.counts as unknown as JsonValue), updated_at: new Date() })
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace).execute();
    return "accepted";
  });
}
