import type { MutationService } from "../storage/mutation-service";
import type { RunId, ScopeId } from "../storage/schema-records";
import type { SqlExecutor, TransactionalSqlExecutor } from "../storage/sql-executor";
import type { EffectIntent, EffectPayload } from "./intents";

export type EvidenceDelivery = { readonly kind: "none" } | { readonly kind: "delivered" } | { readonly kind: "deferred"; readonly detail: string };
interface EvidenceRow { readonly id: string; readonly execution_id: string | null; readonly scope_id: ScopeId; readonly run_id: RunId; readonly payload: EffectPayload }

/** Delivery is receipt-backed: repeating the same evidence after a crash is a replay, not a second fact. */
export async function deliverEvidence(db: TransactionalSqlExecutor, mutations: MutationService, intent: Pick<EffectIntent, "id" | "scope_id" | "execution_id" | "payload">): Promise<EvidenceDelivery> {
  const evidence = intent.payload.evidence;
  if (!evidence || intent.payload.evidence_delivered) return { kind: "none" };
  const owners = await db.query<{ run_id: RunId }>("SELECT run_id FROM authority.scope_instance WHERE id=$1", [intent.scope_id]);
  const run_id = owners[0]?.run_id;
  if (!run_id) return { kind: "deferred", detail: "evidence owner missing" };
  const result = await mutations.decide({ run_id, scope_id: intent.scope_id as ScopeId, ingress_id: evidence.id, trigger: evidence, operator_version: null, execution_authority: intent.execution_id ?? undefined });
  if (!result.ok) return { kind: "deferred", detail: result.error.detail };
  if (result.value.kind === "snapshot_too_large") return { kind: "deferred", detail: `snapshot_too_large: ${result.value.scope} ${result.value.bytes}/${result.value.limit}` };
  const accepted = result.value.kind === "Committed" || result.value.kind === "Replayed" || (result.value.kind === "Rejected"
    && (result.value.reason === "owner_terminal" || result.value.reason === "generation_revoked"));
  if (!accepted) return { kind: "deferred", detail: result.value.detail };
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [run_id]);
    await tx.query("UPDATE authority.effect_intent SET payload=jsonb_set(payload,'{evidence_delivered}','true'),version=version+1 WHERE id=$1 AND payload->'evidence'=$2::jsonb", [intent.id, JSON.stringify(evidence)]);
  });
  return { kind: "delivered" };
}

export async function undeliveredEvidence(db: SqlExecutor, run_id: RunId): Promise<readonly EvidenceRow[]> {
  return db.query<EvidenceRow>(`SELECT e.id,e.execution_id,e.scope_id,s.run_id,e.payload FROM authority.effect_intent e
    JOIN authority.scope_instance s ON s.id=e.scope_id WHERE s.run_id=$1 AND e.payload ? 'evidence'
    AND NOT coalesce((e.payload->>'evidence_delivered')::boolean,false) ORDER BY e.id`, [run_id]);
}
