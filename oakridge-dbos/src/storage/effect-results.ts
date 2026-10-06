import type { CheckedValue } from "../core-client/generated-contracts";
import type { TransactionalSqlExecutor } from "./sql-executor";
import { finishClaim, type ClaimedIntent, type EffectPayload, type EffectStatus } from "../effects/leases";

export interface EffectResultInput {
  readonly claim: ClaimedIntent;
  readonly status: EffectStatus;
  readonly payload: EffectPayload;
  readonly terminal_result: CheckedValue | null;
}

/** Lease acknowledgement and domain result commit together; stale claims write nothing. */
export async function persistEffectResult(db: TransactionalSqlExecutor, input: EffectResultInput): Promise<boolean> {
  const { claim, status, payload, terminal_result } = input;
  const { action, invocation } = claim.payload;
  return db.transaction(async (tx) => {
    if (!await finishClaim(tx, claim, status, payload)) return false;
    if (terminal_result && claim.execution_id) {
      await tx.query("UPDATE authority.execution SET result=$1,status='terminal',version=version+1 WHERE id=$2", [JSON.stringify(terminal_result), claim.execution_id]);
      await tx.query("INSERT INTO authority.fact (id,scope_id,fact_key,payload) VALUES ($1,$2,$3,$4)", [crypto.randomUUID(), claim.scope_id, invocation.id, JSON.stringify(terminal_result)]);
      await tx.query("UPDATE authority.scope_instance SET version=version+1 WHERE id=$1", [claim.scope_id]);
    }
    if (action === "start" && status === "acknowledged") {
      await tx.query(`INSERT INTO authority.effect_intent (id,scope_id,execution_id,effect_key,payload,status)
        VALUES ($1,$2,$3,$4,$5,'pending') ON CONFLICT (scope_id,effect_key) DO NOTHING`,
        [crypto.randomUUID(), claim.scope_id, claim.execution_id, `${claim.effect_key}:observe`, JSON.stringify({ invocation, action: "observe", handle: payload.handle })]);
    }
    return true;
  });
}
