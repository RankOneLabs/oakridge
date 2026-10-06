import type { CheckedValue } from "../core-client/generated-contracts";
import type { TransactionalSqlExecutor } from "./sql-executor";
import { requiresCleanup, type EffectPayload, type EffectStatus } from "../effects/intents";
import { ensureStopIntent } from "./revocation";

export interface EffectResultInput {
  readonly intent_id: string;
  readonly status: EffectStatus;
  readonly payload: EffectPayload;
  readonly terminal_result: CheckedValue | null;
}
interface WrittenRow { readonly status: EffectStatus; readonly scope_id: string; readonly execution_id: string | null; readonly effect_key: string }

/**
 * Claims the right to call the provider for a start: records `has_dispatched`
 * so a crash inside the call leaves a cleanup obligation. Only a still-pending
 * start can be claimed — a revocation that landed since the workflow loaded the
 * row wins, and owes no stop because the provider is then never called.
 */
export async function claimDispatch(db: TransactionalSqlExecutor, intent_id: string): Promise<boolean> {
  const rows = await db.query<{ id: string }>("UPDATE authority.effect_intent SET payload=jsonb_set(payload,'{has_dispatched}','true'),version=version+1 WHERE id=$1 AND payload->>'action'='start' AND status='pending' RETURNING id", [intent_id]);
  return rows.length === 1;
}

/**
 * Record what a provider call taught us, with the domain result in the same
 * transaction. A revocation that landed while the call was in flight wins over
 * every status except cleanup proof: the stop intent it created still needs the
 * handle we just learned, so the payload is written either way.
 */
export async function persistEffectResult(db: TransactionalSqlExecutor, input: EffectResultInput): Promise<EffectStatus | null> {
  const { intent_id, status, payload, terminal_result } = input;
  return db.transaction(async (tx) => {
    const rows = await tx.query<WrittenRow>(`UPDATE authority.effect_intent SET payload=$2,
      status=CASE WHEN status='revoked' AND $3<>'cleanup_confirmed' THEN status ELSE $3 END, version=version+1
      WHERE id=$1 RETURNING status,scope_id,execution_id,effect_key`, [intent_id, JSON.stringify(payload), status]);
    const written = rows[0];
    if (!written) return null;
    // A later rejection cannot prove an earlier uncertain attempt never started.
    // Commit its stop before evidence can make the run terminal.
    if (written.status === "rejected" && requiresCleanup({ status: written.status, payload })) {
      await ensureStopIntent(tx, { ...written, payload });
    }
    if (terminal_result && written.execution_id) {
      // A step that crashed after this transaction committed re-runs; the result is recorded once.
      const facts = await tx.query<{ id: string }>(`INSERT INTO authority.fact (id,scope_id,fact_key,payload) SELECT $1,$2,$3,$4
        WHERE NOT EXISTS (SELECT 1 FROM authority.fact WHERE scope_id=$2 AND fact_key=$3) RETURNING id`, [crypto.randomUUID(), written.scope_id, payload.invocation.id, JSON.stringify(terminal_result)]);
      if (facts.length) {
        await tx.query("UPDATE authority.execution SET result=$1,status='terminal',version=version+1 WHERE id=$2", [JSON.stringify(terminal_result), written.execution_id]);
        await tx.query("UPDATE authority.scope_instance SET version=version+1 WHERE id=$1", [written.scope_id]);
      }
    }
    return written.status;
  });
}
