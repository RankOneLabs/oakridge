import type { ExecutionRecord, Version, VersionedRecord } from "../storage/schema-records";

// pg returns PostgreSQL bigint columns as strings; other executors may return numbers.
export type SqlVersion = Version | string;
export interface SqlVersionedRecord { readonly version: SqlVersion }
export type StoredVersionedRecord<Row extends VersionedRecord> = Omit<Row, "version"> & SqlVersionedRecord;
export type NormalizedVersionedRecord<Row extends SqlVersionedRecord> = Omit<Row, "version"> & { readonly version: Version };
export type StoredExecutionRecord = Omit<ExecutionRecord, "version" | "generation"> & SqlVersionedRecord & { readonly generation: SqlVersion };
export type RecordVersion = Pick<VersionedRecord, "id" | "version">;

export function normalizeRecordVersion<Row extends SqlVersionedRecord>(row: Row): NormalizedVersionedRecord<Row> {
  return { ...row, version: Number(row.version) };
}
export function normalizeExecutionRecord(row: StoredExecutionRecord): ExecutionRecord {
  return normalizeRecordVersion({ ...row, generation: Number(row.generation) });
}
export function selectRecordVersions(rows: readonly VersionedRecord[]): readonly RecordVersion[] {
  return rows.map(({ id, version }) => ({ id, version }));
}
