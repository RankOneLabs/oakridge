import type { ExecutionRecord, Version, VersionedRecord } from "../storage/schema-records";

// pg returns PostgreSQL bigint columns as strings; other executors may return numbers.
export type SqlVersion = Version | string;
export interface SqlVersionedRecord { readonly version: SqlVersion }
export type StoredVersionedRecord<Row extends VersionedRecord> = Omit<Row, "version"> & SqlVersionedRecord;
export type NormalizedVersionedRecord<Row extends SqlVersionedRecord> = Omit<Row, "version"> & { readonly version: Version };
/** An execution as projections expose it: never its publication secret hash. */
export type ExecutionView = Pick<ExecutionRecord, "id" | "scope_id" | "worker_key" | "generation" | "status" | "result" | "version">;
export type StoredExecutionRecord = Omit<ExecutionView, "version" | "generation"> & SqlVersionedRecord & { readonly generation: SqlVersion };
export type RecordVersion = Pick<VersionedRecord, "id" | "version">;

export function normalizeRecordVersion<Row extends SqlVersionedRecord>(row: Row): NormalizedVersionedRecord<Row> {
  return { ...row, version: Number(row.version) };
}
export function normalizeExecutionRecord(row: StoredExecutionRecord): ExecutionView {
  return { id: row.id, scope_id: row.scope_id, worker_key: row.worker_key,
    generation: Number(row.generation), status: row.status, result: row.result, version: Number(row.version) };
}
export function selectRecordVersions(rows: readonly VersionedRecord[]): readonly RecordVersion[] {
  return rows.map(({ id, version }) => ({ id, version }));
}

export interface StoredTransitionHistory<Timestamp> {
  readonly id: string; readonly trigger_id: string; readonly decision: import("../core-client/generated-contracts").DecisionOutcome;
  readonly created_at: Timestamp; readonly version: SqlVersion;
}
export interface TransitionHistory<Timestamp> extends Omit<StoredTransitionHistory<Timestamp>, "version"> { readonly version: number }
export function selectTransitionHistory<Timestamp>(row: StoredTransitionHistory<Timestamp>): TransitionHistory<Timestamp> {
  return { id: row.id, trigger_id: row.trigger_id, decision: row.decision, created_at: row.created_at, version: Number(row.version) };
}
