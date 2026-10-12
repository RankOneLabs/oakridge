import type { MutationService } from "../storage/mutation-service";
import type { EffectIntentRecord, RunId } from "../storage/schema-records";
import type { SqlExecutor, TransactionalSqlExecutor } from "../storage/sql-executor";
import type { EffectIntent, EffectPayload } from "./intents";

export type EvidenceDelivery = { readonly kind: "none" } | { readonly kind: "delivered" } | { readonly kind: "deferred"; readonly detail: string };
type EvidenceRow = Pick<EffectIntentRecord, "id" | "run_id" | "unit_id" | "action_id"> & { readonly payload: EffectPayload };

/**
 * Evidence a provider produced is delivered as one authority event, keyed on
 * the intent so a repeat after a crash replays through ingress rather than
 * landing twice.
 */
export async function deliverEvidence(db: TransactionalSqlExecutor, mutations: MutationService,
  intent: Pick<EffectIntent, "id" | "run_id" | "payload">): Promise<EvidenceDelivery> {
  const evidence = intent.payload.evidence;
  if (!evidence || intent.payload.evidence_delivered) return { kind: "none" };
  const submitted = await mutations.submit({
    run_id: intent.run_id as RunId, ingress_id: `evidence:${intent.id}`,
    event: evidence, writer: { kind: "executor", attempt: intent.payload.invocation.id },
  });
  if (!submitted.ok) return { kind: "deferred", detail: submitted.error.detail };
  const result = submitted.value;
  if (result.kind === "conflict" || result.kind === "rejected") return { kind: "deferred", detail: result.detail };
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [intent.run_id]);
    await tx.query("UPDATE authority.effect_intent SET payload=jsonb_set(payload,'{evidence_delivered}','true'),updated_at=now() WHERE id=$1", [intent.id]);
  });
  return { kind: "delivered" };
}

export async function undeliveredEvidence(db: SqlExecutor, run_id: RunId): Promise<readonly EvidenceRow[]> {
  return db.query<EvidenceRow>(`SELECT e.id,e.run_id,e.unit_id,e.action_id,e.payload FROM authority.effect_intent e
    WHERE e.run_id=$1 AND e.payload ? 'evidence'
    AND NOT coalesce((e.payload->>'evidence_delivered')::boolean,false) ORDER BY e.id`, [run_id]);
}
