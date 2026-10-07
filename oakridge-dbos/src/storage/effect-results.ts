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

/** Reserve one bounded attempt before provider IO; recovery cannot reset the budget. */
export async function claimStartAttempt(db: TransactionalSqlExecutor, intent_id: string): Promise<EffectPayload | null> {
  const owner = await db.query<{ run_id: string }>("SELECT s.run_id FROM authority.effect_intent e JOIN authority.scope_instance s ON s.id=e.scope_id WHERE e.id=$1", [intent_id]);
  if (!owner[0]) return null;
  return db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [owner[0]!.run_id]);
    const rows = await tx.query<{ payload: EffectPayload }>(`UPDATE authority.effect_intent
      SET payload=jsonb_set(jsonb_set(payload,'{has_dispatched}','true'),'{start_attempts}',
        to_jsonb(coalesce((payload->>'start_attempts')::integer,0)+1)),version=version+1
      WHERE id=$1 AND payload->>'action'='start' AND status='pending'
        AND coalesce((payload->>'start_attempts')::integer,0) < (payload->'invocation'->'selection'->'definition'->>'max_attempts')::integer
      RETURNING payload`, [intent_id]);
    return rows[0]?.payload ?? null;
  });
}

/**
 * Record what a provider call taught us, with the domain result in the same
 * transaction. A revocation that landed while the call was in flight wins over
 * every status except cleanup proof: the stop intent it created still needs the
 * handle we just learned, so the payload is written either way.
 */
export async function persistEffectResult(db: TransactionalSqlExecutor, input: EffectResultInput): Promise<EffectStatus | null> {
  const { intent_id, status, payload, terminal_result } = input;
  const owner = await db.query<{ run_id: string }>("SELECT s.run_id FROM authority.effect_intent e JOIN authority.scope_instance s ON s.id=e.scope_id WHERE e.id=$1", [intent_id]);
  if (!owner[0]) return null;
  return db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [owner[0]!.run_id]);
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
