import type { EffectIntentRecord, ExecutionRecord, ResourceBindingRecord } from "../storage/schema-records";
import type { TransactionalSqlExecutor } from "../storage/sql-executor";

import { normalizeExecutionRecord, normalizeRecordVersion, selectRecordVersions, type RecordVersion, type StoredExecutionRecord, type StoredVersionedRecord } from "../projections/record-selectors";

export type EffectDiagnosticRecord = Pick<EffectIntentRecord, "id" | "effect_key" | "status" | "version">;
export interface DiagnosticsCursor {
  readonly scope_version: number;
  readonly executions: readonly RecordVersion[];
  readonly resources: readonly RecordVersion[];
  readonly effects: readonly RecordVersion[];
}
export interface ScopeDiagnostics {
  readonly scope_id: string; readonly scope_version: number;
  readonly executions: readonly ExecutionRecord[]; readonly resources: readonly ResourceBindingRecord[];
  readonly effects: readonly EffectDiagnosticRecord[];
  readonly cursor: DiagnosticsCursor;
}
export async function readScopeDiagnostics(db: TransactionalSqlExecutor, scope_id: string): Promise<ScopeDiagnostics | null> {
  return db.transaction(async (tx) => {
    const owner = (await tx.query<{ version: string | number }>("SELECT version FROM authority.scope_instance WHERE id=$1", [scope_id]))[0];
    if (!owner) return null;
    const executions = (await tx.query<StoredExecutionRecord>("SELECT * FROM authority.execution WHERE scope_id=$1 ORDER BY id", [scope_id])).map(normalizeExecutionRecord);
    const resources = (await tx.query<StoredVersionedRecord<ResourceBindingRecord>>("SELECT * FROM authority.resource_binding WHERE scope_id=$1 ORDER BY id", [scope_id])).map(normalizeRecordVersion);
    const effects = (await tx.query<StoredVersionedRecord<EffectDiagnosticRecord>>("SELECT id,effect_key,status,version FROM authority.effect_intent WHERE scope_id=$1 ORDER BY id", [scope_id])).map(normalizeRecordVersion);
    const scope_version = Number(owner.version);
    return { scope_id, scope_version, executions, resources, effects,
      cursor: { scope_version, executions: selectRecordVersions(executions), resources: selectRecordVersions(resources), effects: selectRecordVersions(effects) } };
  }, "repeatable read");
}
