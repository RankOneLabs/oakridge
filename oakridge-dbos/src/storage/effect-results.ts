import type { TransactionalSqlExecutor } from "./sql-executor";
import type { EffectIntent, EffectPayload, EffectStatus } from "../effects/intents";
import { sealEffectPayload, unsealEffectPayload } from "./effect-secret";

export interface EffectResultInput {
  readonly intent_id: string;
  readonly status: EffectStatus;
  readonly payload: EffectPayload;
}
type WrittenRow = Pick<EffectIntent, "status" | "run_id" | "unit_id" | "action_id">;

/** The run owning an intent; v2 keeps run_id on the row itself. */
async function intentOwner(db: TransactionalSqlExecutor, intent_id: string): Promise<string | null> {
  const rows = await db.query<{ run_id: string }>("SELECT run_id FROM authority.effect_intent WHERE id=$1", [intent_id]);
  return rows[0]?.run_id ?? null;
}

/**
 * Reserve before provider IO. An unfinished predecessor (including a row
 * dispatched without settlement metadata) remains an uncertain start.
 */
export async function claimStartAttempt(db: TransactionalSqlExecutor, intent_id: string): Promise<EffectPayload | null> {
  const run_id = await intentOwner(db, intent_id);
  if (run_id === null) return null;
  return db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [run_id]);
    const rows = await tx.query<{ payload: EffectPayload }>(`UPDATE authority.effect_intent
      SET payload=payload || jsonb_build_object(
        'has_dispatched',true,
        'start_attempts',coalesce((payload->>'start_attempts')::bigint,0)+1,
        'start_in_flight',true,
        'has_uncertain_start',coalesce((payload->>'has_uncertain_start')::boolean,false)
          OR coalesce((payload->>'start_in_flight')::boolean,false)
          OR (NOT (payload ? 'start_in_flight') AND coalesce((payload->>'has_dispatched')::boolean,false))),
        updated_at=now()
      WHERE id=$1 AND status='pending'
        AND coalesce((payload->>'start_attempts')::bigint,0) < (payload->'invocation'->>'max_start_attempts')::bigint
      RETURNING payload`, [intent_id]);
    return rows[0] ? unsealEffectPayload(rows[0].payload) : null;
  });
}

/**
 * Record what a provider call taught us. v2 transitions the action's own row in
 * place, so a requested stop is never downgraded by a late acknowledgement:
 * only a terminal status (stopped or failed) may move it on. The caller turns a
 * terminal result into a `worker_ended` event; storage records no facts.
 */
export async function persistEffectResult(db: TransactionalSqlExecutor, input: EffectResultInput): Promise<EffectStatus | null> {
  const { intent_id, status, payload } = input;
  const run_id = await intentOwner(db, intent_id);
  if (run_id === null) return null;
  return db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [run_id]);
    const rows = await tx.query<WrittenRow>(`UPDATE authority.effect_intent SET payload=$2,
      status=CASE WHEN status='stop_requested' AND $3::authority.effect_status NOT IN ('stopped','failed')
        THEN status ELSE $3::authority.effect_status END, updated_at=now()
      WHERE id=$1 RETURNING status,run_id,unit_id,action_id`, [intent_id, JSON.stringify(sealEffectPayload(payload)), status]);
    return rows[0]?.status ?? null;
  });
}
