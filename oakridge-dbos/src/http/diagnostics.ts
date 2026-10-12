import type { EffectIntentRecord, AttemptRecord } from "../storage/schema-records";
import type { Event as CoreEvent, Writer } from "../core-client/core-types";
import type { TransactionalSqlExecutor } from "../storage/sql-executor";
import { selectAttemptView, type AttemptView } from "../projections/record-selectors";

export type EffectDiagnosticRecord = Pick<EffectIntentRecord, "id" | "action_id" | "seq" | "status">;

export interface UnitDiagnostics {
  readonly unit_id: string;
  readonly unit_version: number;
  readonly attempts: readonly AttemptView[];
  readonly effects: readonly EffectDiagnosticRecord[];
}

/** One committed event as the diagnostics view replays it. */
export interface UnitEventHistory {
  readonly id: string;
  readonly payload: CoreEvent;
  readonly writer: Writer;
  readonly created_at: Date;
}
export interface UnitHistory {
  readonly unit_id: string;
  readonly events: readonly UnitEventHistory[];
}

/** v2 replaced the transition and fact logs with one append-only event log. */
export async function readUnitHistory(db: TransactionalSqlExecutor, run_id: string, unit_id: string): Promise<UnitHistory | null> {
  return db.transaction(async (tx) => {
    const owner = await tx.query<{ id: string }>("SELECT id FROM authority.unit WHERE run_id=$1 AND id=$2", [run_id, unit_id]);
    if (!owner.length) return null;
    const events = await tx.query<UnitEventHistory>(
      "SELECT id,payload,writer,created_at FROM authority.event WHERE run_id=$1 AND unit_id=$2 ORDER BY created_at DESC,id DESC", [run_id, unit_id]);
    return { unit_id, events };
  }, "repeatable read");
}

export async function readUnitDiagnostics(db: TransactionalSqlExecutor, run_id: string, unit_id: string): Promise<UnitDiagnostics | null> {
  return db.transaction(async (tx) => {
    const owner = (await tx.query<{ version: string | number }>("SELECT version FROM authority.unit WHERE run_id=$1 AND id=$2", [run_id, unit_id]))[0];
    if (!owner) return null;
    const attempts = (await tx.query<AttemptRecord>(
      "SELECT * FROM authority.attempt WHERE run_id=$1 AND unit_id=$2 ORDER BY action_id,seq", [run_id, unit_id])).map(selectAttemptView);
    const effects = await tx.query<EffectDiagnosticRecord>(
      "SELECT id,action_id,seq,status FROM authority.effect_intent WHERE run_id=$1 AND unit_id=$2 ORDER BY id", [run_id, unit_id]);
    return { unit_id, unit_version: Number(owner.version), attempts, effects };
  }, "repeatable read");
}
