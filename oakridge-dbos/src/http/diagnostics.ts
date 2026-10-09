import type { EffectIntentRecord, ResourceBindingRecord } from "../storage/schema-records";
import type { TransactionalSqlExecutor } from "../storage/sql-executor";

import { normalizeExecutionRecord, normalizeRecordVersion, selectRecordVersions, selectTransitionHistory, type ExecutionView, type RecordVersion, type StoredExecutionRecord, type StoredTransitionHistory, type StoredVersionedRecord, type TransitionHistory } from "../projections/record-selectors";

export type EffectDiagnosticRecord = Pick<EffectIntentRecord, "id" | "effect_key" | "status" | "version">;
export interface DiagnosticsCursor {
  readonly scope_version: number;
  readonly executions: readonly RecordVersion[];
  readonly resources: readonly RecordVersion[];
  readonly effects: readonly RecordVersion[];
}
export interface ScopeDiagnostics {
  readonly scope_id: string; readonly scope_version: number;
  readonly executions: readonly ExecutionView[]; readonly resources: readonly ResourceBindingRecord[];
  readonly effects: readonly EffectDiagnosticRecord[];
  readonly cursor: DiagnosticsCursor;
}
export interface ScopeFactHistory { readonly id: string; readonly fact_key: string; readonly payload: import("../core-client/generated-contracts").CheckedValue }
export interface ScopeHistory {
  readonly scope_id: string;
  readonly transitions: readonly TransitionHistory<Date>[];
  readonly facts: readonly ScopeFactHistory[];
}
export async function readScopeHistory(db: TransactionalSqlExecutor, run_id: string, scope_id: string): Promise<ScopeHistory | null> {
  return db.transaction(async (tx) => {
    const owner = await tx.query<{ id: string }>("SELECT id FROM authority.scope_instance WHERE run_id=$1 AND id=$2", [run_id, scope_id]);
    if (!owner.length) return null;
    const transitions = (await tx.query<StoredTransitionHistory<Date>>(
      "SELECT id,trigger_id,decision,created_at,version FROM authority.transition WHERE run_id=$1 AND scope_id=$2 ORDER BY created_at DESC,id DESC", [run_id, scope_id])).map(selectTransitionHistory);
    const facts = await tx.query<ScopeFactHistory>(
      "SELECT id,fact_key,payload FROM authority.fact WHERE run_id=$1 AND scope_id=$2 ORDER BY id", [run_id, scope_id]);
    return { scope_id, transitions, facts };
  }, "repeatable read");
}
export async function readScopeDiagnostics(db: TransactionalSqlExecutor, scope_id: string): Promise<ScopeDiagnostics | null> {
  return db.transaction(async (tx) => {
    const owner = (await tx.query<{ version: string | number }>("SELECT version FROM authority.scope_instance WHERE id=$1", [scope_id]))[0];
    if (!owner) return null;
    const executions = (await tx.query<StoredExecutionRecord>("SELECT id,scope_id,worker_key,generation,status,result,version FROM authority.execution WHERE scope_id=$1 ORDER BY id", [scope_id])).map(normalizeExecutionRecord);
    const resources = (await tx.query<StoredVersionedRecord<ResourceBindingRecord>>("SELECT * FROM authority.resource_binding WHERE scope_id=$1 ORDER BY id", [scope_id])).map(normalizeRecordVersion);
    const effects = (await tx.query<StoredVersionedRecord<EffectDiagnosticRecord>>("SELECT id,effect_key,status,version FROM authority.effect_intent WHERE scope_id=$1 ORDER BY id", [scope_id])).map(normalizeRecordVersion);
    const scope_version = Number(owner.version);
    return { scope_id, scope_version, executions, resources, effects,
      cursor: { scope_version, executions: selectRecordVersions(executions), resources: selectRecordVersions(resources), effects: selectRecordVersions(effects) } };
  }, "repeatable read");
}
