import type { AttemptRecord, Version, VersionedRecord } from "../storage/schema-records";

// pg returns PostgreSQL bigint columns as strings; other executors may return numbers.
export type SqlVersion = Version | string;
export interface SqlVersionedRecord { readonly version: SqlVersion }
export type StoredVersionedRecord<Row extends VersionedRecord> = Omit<Row, "version"> & SqlVersionedRecord;
export type NormalizedVersionedRecord<Row extends SqlVersionedRecord> = Omit<Row, "version"> & { readonly version: Version };
/** An attempt as projections expose it: never its publication secret hash. */
export type AttemptView = Pick<AttemptRecord, "action_id" | "seq" | "unit_id" | "worker" | "mode" | "cause" | "status" | "ended_at" | "kbbl_session_id">;
export type RecordVersion = Pick<VersionedRecord, "id" | "version">;

export function normalizeRecordVersion<Row extends SqlVersionedRecord>(row: Row): NormalizedVersionedRecord<Row> {
  return { ...row, version: Number(row.version) };
}
export function selectAttemptView(row: AttemptRecord): AttemptView {
  return { action_id: row.action_id, seq: Number(row.seq), unit_id: row.unit_id, worker: row.worker,
    mode: row.mode, cause: row.cause, status: row.status, ended_at: row.ended_at, kbbl_session_id: row.kbbl_session_id };
}
export function selectRecordVersions(rows: readonly VersionedRecord[]): readonly RecordVersion[] {
  return rows.map(({ id, version }) => ({ id, version }));
}

