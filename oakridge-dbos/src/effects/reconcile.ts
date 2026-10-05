import type { SqlExecutor, TransactionalSqlExecutor } from "../storage/sql-executor";
import { pendingCleanupCount, type EffectPayload } from "./leases";
import { selectedInvocation, type InvocationId } from "./provider";
import type { DecisionOutcome } from "../core-client/generated-contracts";

export interface CancelRunCommand { readonly kind: "cancel_run"; readonly run_id: string; readonly reason: string }
export type CancelRunResult = { readonly kind: "cancelled"; readonly stop_intents: number } | { readonly kind: "missing" };
export type DeleteEligibility = { readonly kind: "allowed" } | { readonly kind: "refused"; readonly obligations: number };

interface LegacyIntent { readonly id: string; readonly scope_id: string; readonly execution_id: string | null; readonly effect_key: string }
interface ReceiptLink { readonly scope_id: string; readonly ingress_id: string; readonly result: { readonly transition_id: string }; readonly decision: DecisionOutcome }

/**
 * The baseline commit stores the checked input in the intent. Recover its full
 * selection through the receipt's transition id and persist it before IO.
 * This also repairs a crash between the decision commit and the first sweep.
 */
async function hydrate(tx: SqlExecutor, run_id: string | null): Promise<number> {
    const intents = await tx.query<LegacyIntent>(`SELECT e.id,e.scope_id,e.execution_id,e.effect_key FROM authority.effect_intent e
      JOIN authority.scope_instance s ON s.id=e.scope_id
      WHERE e.status='pending' AND e.payload ? 'schema' AND ($1::text IS NULL OR s.run_id=$1)
      FOR UPDATE OF e ${run_id === null ? "SKIP LOCKED" : ""}`, [run_id]);
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
      const invocation = selectedInvocation(intent.id as InvocationId, intent.execution_id, selected);
      const payload: EffectPayload = { invocation, action: "start", handle: null };
      await tx.query("UPDATE authority.effect_intent SET payload=$1,version=version+1 WHERE id=$2", [JSON.stringify(payload), intent.id]);
      count++;
    }
    return count;
}

export async function materializeSelectedIntents(db: TransactionalSqlExecutor): Promise<number> {
  return db.transaction((tx) => hydrate(tx, null));
}

/** Revoke authority and retain a stop identity for every selected start in one transaction. */
export async function cancelRun(db: TransactionalSqlExecutor, command: CancelRunCommand): Promise<CancelRunResult> {
  return db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [command.run_id]);
    const runs = await tx.query<{ id: string }>("SELECT id FROM authority.run WHERE id=$1 FOR UPDATE", [command.run_id]);
    if (!runs.length) return { kind: "missing" };
    await hydrate(tx, command.run_id);
    await tx.query(`UPDATE authority.execution_selection SET execution_id=NULL,generation=generation+1,version=version+1
      WHERE scope_id IN (SELECT id FROM authority.scope_instance WHERE run_id=$1) AND execution_id IS NOT NULL`, [command.run_id]);
    const starts = await tx.query<{ id: string; scope_id: string; execution_id: string | null; effect_key: string; payload: EffectPayload; status: string }>(`SELECT e.* FROM authority.effect_intent e
      JOIN authority.scope_instance s ON s.id=e.scope_id WHERE s.run_id=$1 AND e.payload->>'action'='start'
      FOR UPDATE OF e`, [command.run_id]);
    for (const start of starts) {
      // A claim already in flight can still create an external process. Its
      // completion is fenced by the row version, while this stop survives it.
      if (start.status === "pending" || start.status === "in_flight" || start.status === "uncertain")
        await tx.query("UPDATE authority.effect_intent SET status='revoked',version=version+1 WHERE id=$1", [start.id]);
      const payload: EffectPayload = { invocation: start.payload.invocation, action: "stop", handle: start.payload.handle ?? null };
      await tx.query(`INSERT INTO authority.effect_intent (id,scope_id,execution_id,effect_key,payload,status)
        VALUES ($1,$2,$3,$4,$5,'cleanup_pending') ON CONFLICT (scope_id,effect_key) DO NOTHING`,
      [crypto.randomUUID(), start.scope_id, start.execution_id, `${start.effect_key}:stop`, JSON.stringify(payload)]);
    }
    return { kind: "cancelled", stop_intents: starts.length };
  });
}

/** A terminal observation or acknowledged stop is the only cleanup proof. */
export async function deletionEligibility(db: TransactionalSqlExecutor, run_id: string): Promise<DeleteEligibility> {
  await materializeSelectedIntents(db);
  const obligations = await pendingCleanupCount(db, run_id);
  return obligations === 0 ? { kind: "allowed" } : { kind: "refused", obligations };
}

export type DeleteRunResult = DeleteEligibility | { readonly kind: "deleted" } | { readonly kind: "missing" };

export async function deleteRun(db: TransactionalSqlExecutor, run_id: string): Promise<DeleteRunResult> {
  return db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [run_id]);
    const runs = await tx.query<{ id: string }>("SELECT id FROM authority.run WHERE id=$1 FOR UPDATE", [run_id]);
    if (!runs.length) return { kind: "missing" };
    await hydrate(tx, run_id);
    const obligations = await pendingCleanupCount(tx, run_id);
    if (obligations) return { kind: "refused", obligations };
    const scopeIds = "SELECT id FROM authority.scope_instance WHERE run_id=$1";
    for (const table of ["ingress_receipt", "effect_intent", "resource_binding", "capacity_reservation", "fact", "transition", "output_slot", "artifact_revision", "execution_selection", "execution", "scope_export", "child_collection"])
      await tx.query(`DELETE FROM authority.${table} WHERE scope_id IN (${scopeIds})`, [run_id]);
    await tx.query("DELETE FROM authority.capacity_pool WHERE run_id=$1", [run_id]);
    await tx.query("DELETE FROM authority.scope_instance WHERE run_id=$1", [run_id]);
    await tx.query("DELETE FROM authority.run WHERE id=$1", [run_id]);
    return { kind: "deleted" };
  });
}
