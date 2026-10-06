import type { SqlExecutor, TransactionalSqlExecutor } from "../storage/sql-executor";
import { pendingCleanupCount, type EffectPayload } from "./leases";
import { pinProviderRequest } from "./operations/selected-request";
import { selectedInvocation, type InvocationId } from "./provider";
import type { DefinitionBundle } from "../core-client/generated-contracts";
import type { RunId, ScopeId } from "../storage/schema-records";
import type { DecisionOutcome } from "../core-client/generated-contracts";

export type DeleteEligibility = { readonly kind: "allowed" } | { readonly kind: "refused"; readonly obligations: number };

interface LegacyIntent { readonly id: string; readonly scope_id: string; readonly execution_id: string | null; readonly effect_key: string }
interface ReceiptLink { readonly scope_id: string; readonly ingress_id: string; readonly result: { readonly transition_id: string }; readonly decision: DecisionOutcome }

/**
 * The baseline commit stores the checked input in the intent. Recover its full
 * selection through the receipt's transition id and persist it before IO.
 * This also repairs a crash between the decision commit and the first sweep.
 */
export async function hydrate(tx: SqlExecutor, run_id: string | null): Promise<number> {
    const statements = {
      all_runs: `SELECT e.id,e.scope_id,e.execution_id,e.effect_key FROM authority.effect_intent e
        JOIN authority.scope_instance s ON s.id=e.scope_id
        WHERE e.status='pending' AND e.payload ? 'schema' AND ($1::text IS NULL OR s.run_id=$1)
        FOR UPDATE OF e SKIP LOCKED`,
      one_run: `SELECT e.id,e.scope_id,e.execution_id,e.effect_key FROM authority.effect_intent e
        JOIN authority.scope_instance s ON s.id=e.scope_id
        WHERE e.status='pending' AND e.payload ? 'schema' AND ($1::text IS NULL OR s.run_id=$1)
        FOR UPDATE OF e`,
    };
    const intents = await tx.query<LegacyIntent>(statements[run_id === null ? "all_runs" : "one_run"], [run_id]);
    if (!intents.length) return 0;
    const receipts = await tx.query<ReceiptLink>(`SELECT r.scope_id,r.ingress_id,r.result,t.decision
      FROM authority.ingress_receipt r JOIN authority.transition t ON t.id=r.result->>'transition_id'
      WHERE r.scope_id=ANY($1::text[])`, [[...new Set(intents.map((intent) => intent.scope_id))]]);
    let count = 0;
    for (const intent of intents) {
      const link = receipts.find((receipt) => intent.scope_id === receipt.scope_id && intent.effect_key.startsWith(`${receipt.ingress_id}:`)
        && /^\d+$/.test(intent.effect_key.slice(receipt.ingress_id.length + 1)));
      const index = link ? Number(intent.effect_key.slice(link.ingress_id.length + 1)) : -1;
      const selected = link?.decision.kind === "apply" ? link.decision.invocations[index] : undefined;
      if (!selected || !intent.execution_id) continue;
      const definitions = await tx.query<{ source: DefinitionBundle; id: string; run_id: RunId; child_key: string | null; scope_key: string }>("SELECT b.source,s.id,s.run_id,s.child_key,s.scope_key FROM authority.definition_bundle b JOIN authority.run r ON r.definition_bundle_id=b.id JOIN authority.scope_instance s ON s.run_id=r.id WHERE s.id=$1", [intent.scope_id]);
      const owner = definitions[0];
      const definition = owner?.source;
      let invocation = selectedInvocation(intent.id as InvocationId, intent.execution_id, selected);
      if (definition?.schemas && owner) {
        const pinned = pinProviderRequest({ invocation, bundle: definition, scope: owner });
        if (!pinned.ok) continue;
        invocation = pinned.value;
      }
      const payload: EffectPayload = { invocation, action: "start", handle: null };
      await tx.query("UPDATE authority.effect_intent SET payload=$1,version=version+1 WHERE id=$2", [JSON.stringify(payload), intent.id]);
      count++;
    }
    return count;
}

export async function materializeSelectedIntents(db: TransactionalSqlExecutor): Promise<number> {
  return db.transaction((tx) => hydrate(tx, null));
}

/** A terminal observation or acknowledged stop is the only cleanup proof. */
export async function deletionEligibility(db: TransactionalSqlExecutor, run_id: string): Promise<DeleteEligibility> {
  await materializeSelectedIntents(db);
  const obligations = await pendingCleanupCount(db, run_id);
  return obligations === 0 ? { kind: "allowed" } : { kind: "refused", obligations };
}

interface EvidenceRow { readonly execution_id: string | null; readonly id: string; readonly scope_id: ScopeId; readonly run_id: RunId; readonly payload: EffectPayload }
/** Delivery is receipt-backed: a crash after the decision safely repeats the same evidence. */
export async function deliverEffectFacts(db: TransactionalSqlExecutor, mutations: import("../storage/mutation-service").MutationService): Promise<void> {
  const rows = await db.query<EvidenceRow>(`SELECT e.id,e.execution_id,e.scope_id,s.run_id,e.payload FROM authority.effect_intent e
    JOIN authority.scope_instance s ON s.id=e.scope_id WHERE e.payload ? 'evidence'
    AND NOT coalesce((e.payload->>'evidence_delivered')::boolean,false) ORDER BY e.id`, []);
  for (const row of rows) {
    const evidence = row.payload.evidence;
    if (!evidence) continue;
    const result = await mutations.decide({ run_id: row.run_id, scope_id: row.scope_id, ingress_id: evidence.id, trigger: evidence, operator_version: null, execution_authority: row.execution_id ?? undefined });
    if (!result.ok || (result.value.kind !== "Committed" && result.value.kind !== "Replayed" && !(result.value.kind === "Rejected" && ["owner is terminal", "execution generation was revoked"].includes(result.value.detail)))) continue;
    await db.query("UPDATE authority.effect_intent SET payload=jsonb_set(payload,'{evidence_delivered}','true'),version=version+1 WHERE id=$1 AND payload->'evidence'=$2::jsonb", [row.id, JSON.stringify(evidence)]);
  }
}
