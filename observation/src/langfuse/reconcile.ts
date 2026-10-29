import { err, ok, type Result } from "../domain/primitives";
import type { CanonicalDigest } from "../domain/identity";
import type { FetchSelector, InboundEvaluation, LangfuseError, ReconcileOutcome,
  ReconcileSelector } from "../ports/evaluation-backend";
import { withTenant, type Database, type TenantScope } from "../storage/database";
import { transitionLangfuseMapping } from "../storage/langfuse-store";

const EMPTY: InboundEvaluation = { scores: [], annotation_outcomes: [] };

/** Repeated reads never rewrite a grade; completion requires an authenticated, queryable score. */
export async function reconcileLangfuseMapping(db: Database, tenant: TenantScope, selector: ReconcileSelector,
  fetch: (selector: FetchSelector) => Promise<Result<InboundEvaluation, LangfuseError>>):
  Promise<Result<ReconcileOutcome, LangfuseError>> {
  const row = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.langfuse_mapping")
    .selectAll().where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("mapping_key", "=", selector.mapping_key).executeTakeFirst());
  if (!row || row.occurrence_id !== selector.occurrence_id || row.question_id !== selector.question_id
    || row.question_version !== selector.question_version)
    return err({ operation: "reconcile", entity_id: selector.mapping_key, detail: "mapping is not authenticated" });
  const ids = row.trace_id && row.observation_id && row.score_id && row.queue_item_id
    ? { trace_id: row.trace_id as NonNullable<ReconcileSelector["external_ids"]>["trace_id"],
      observation_id: row.observation_id as NonNullable<ReconcileSelector["external_ids"]>["observation_id"],
      score_id: row.score_id as NonNullable<ReconcileSelector["external_ids"]>["score_id"],
      queue_item_id: row.queue_item_id as NonNullable<ReconcileSelector["external_ids"]>["queue_item_id"] } : null;
  if (selector.external_ids && (!ids || Object.keys(ids).some((key) =>
    ids[key as keyof typeof ids] !== selector.external_ids![key as keyof typeof ids])))
    return err({ operation: "reconcile", entity_id: selector.mapping_key, detail: "external identifiers differ from mapping" });
  if (row.sync_state === "completed") return ok({ external_ids: ids, inbound: EMPTY,
    sync_state: { status: "completed", mapping_key: selector.mapping_key, completed_at: row.updated_at.toISOString() } });
  const pending = await transitionLangfuseMapping(db, tenant, selector.mapping_key as CanonicalDigest, "pending");
  if (!pending.ok) return pending;
  if (!ids) return ok({ external_ids: null, inbound: EMPTY,
    sync_state: { status: "pending", mapping_key: selector.mapping_key, last_checked_at: pending.value.updated_at.toISOString() } });
  const inbound = await fetch({ mapping_key: selector.mapping_key, external_ids: ids });
  if (!inbound.ok) return inbound;
  const completed = inbound.value.scores.length > 0;
  const updated = await transitionLangfuseMapping(db, tenant, selector.mapping_key as CanonicalDigest,
    completed ? "completed" : "pending");
  if (!updated.ok) return updated;
  return ok({ external_ids: ids, inbound: inbound.value,
    sync_state: completed ? { status: "completed", mapping_key: selector.mapping_key,
      completed_at: updated.value.updated_at.toISOString() }
      : { status: "pending", mapping_key: selector.mapping_key,
        last_checked_at: updated.value.updated_at.toISOString() } });
}
