import type { CheckedValue } from "../core-client/generated-contracts";
import type { TransactionalSqlExecutor } from "./sql-executor";
import type { EffectPayload, EffectStatus } from "../effects/intents";

export interface EffectResultInput {
  readonly intent_id: string;
  readonly status: EffectStatus;
  readonly payload: EffectPayload;
  readonly terminal_result: CheckedValue | null;
}
interface WrittenRow { readonly status: EffectStatus; readonly scope_id: string; readonly execution_id: string | null }

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
      WHERE id=$1 RETURNING status,scope_id,execution_id`, [intent_id, JSON.stringify(payload), status]);
    const written = rows[0];
    if (!written) return null;
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
