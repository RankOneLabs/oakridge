import { sql, type Selectable } from "kysely";
import type { JsonValue } from "../domain/primitives";
import { selectCaptures, type CaptureSource } from "../ingest/capture";
import type { CommittedEventDelivery, InputBinding, RevisionOrigin } from "../ingest/dbos-revision-delivery";
import { INITIAL_SOURCE_CURSOR, type SourceEventAck, type SourceEventCursor } from "../ingest/cursor";
import { jsonText, withTenant, type Database, type DatabaseTransaction, type TenantScope } from "./database";
import type { ObservationSourceRevision } from "./db-types";
import { lockSourceCursor, projectRevisionInTransaction, type ProjectionContext } from "./projection-store";

export interface SourceRevisionRead extends CaptureSource {
  readonly id: string;
  readonly captured_at: string;
}
export type CaptureOutcome =
  | { readonly kind: "captured" }
  | { readonly kind: "identical" }
  | { readonly kind: "revision_identity_conflict"; readonly stored_digest: string; readonly incoming_digest: string };

function sourceRead(row: Selectable<ObservationSourceRevision>): SourceRevisionRead {
  return { ...row, id: row.revision_id, recorded_at: row.recorded_at.toISOString(), captured_at: row.captured_at.toISOString() };
}

/** A revision id names one immutable revision for its producer and namespace. */
export async function captureInTransaction(trx: DatabaseTransaction, source: CaptureSource): Promise<CaptureOutcome> {
  const { producer, namespace, revision_id, body, body_digest, origin, input_bindings, recorded_at } = source;
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([producer, namespace, revision_id])}, 0))`.execute(trx);
  const existing = await trx.selectFrom("observation.source_revision").selectAll()
    .where("producer", "=", producer).where("namespace", "=", namespace).where("revision_id", "=", revision_id).executeTakeFirst();
  if (existing) {
    const stored = sourceRead(existing);
    const same = stored.body_digest === body_digest && stored.predecessor_id === source.predecessor_id && stored.subject_id === source.subject_id
      && stored.stage === source.stage && stored.run_id === source.run_id && stored.unit_id === source.unit_id
      && stored.artifact_kind === source.artifact_kind && stored.artifact_schema_version === source.artifact_schema_version
      && stored.definition_id === source.definition_id && stored.recorded_at === new Date(recorded_at).toISOString()
      && sameOrigin(stored.origin, origin) && sameBindings(stored.input_bindings, input_bindings);
    return same ? { kind: "identical" } : { kind: "revision_identity_conflict", stored_digest: stored.body_digest, incoming_digest: body_digest };
  }
  await trx.insertInto("observation.source_revision").values({ ...source, body: jsonText(body), origin: jsonText(origin),
    input_bindings: jsonText(input_bindings), recorded_at: new Date(recorded_at) }).execute();
  return { kind: "captured" };
}
const sameOrigin = (left: RevisionOrigin, right: RevisionOrigin): boolean =>
  left.kind === right.kind && (left.kind === "operator_edit" ||
    (right.kind === "worker" && left.action_id === right.action_id && left.seq === right.seq));
const sameBindings = (left: readonly InputBinding[], right: readonly InputBinding[]): boolean =>
  left.length === right.length && left.every((binding, index) => {
    const other = right[index];
    return other?.input === binding.input && other.unit === binding.unit && other.revision_id === binding.revision_id;
  });

export function readSourceRevision(db: Database, tenant: TenantScope, revision_id: string): Promise<SourceRevisionRead | null> {
  return withTenant(db, tenant, async (trx) => {
    const row = await trx.selectFrom("observation.source_revision").selectAll()
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("revision_id", "=", revision_id).executeTakeFirst();
    return row ? sourceRead(row) : null;
  });
}

export function readSourceCursor(db: Database, tenant: TenantScope): Promise<SourceEventAck> {
  return withTenant(db, tenant, async (trx) => {
    const row = await sql<SourceEventCursor>`SELECT commit_txid::text AS commit_txid, event_id
      FROM observation.source_event_cursor WHERE producer = ${tenant.producer} AND namespace = ${tenant.namespace}`.execute(trx);
    return { cursor: row.rows[0] ?? INITIAL_SOURCE_CURSOR };
  });
}

export interface SourceEventConflict { readonly error: { readonly code: "cursor_conflict"; readonly cursor: SourceEventCursor } }
export interface SourceEventDeliveryResult { readonly status: 200 | 409; readonly body: SourceEventAck | SourceEventConflict }
const sameCursor = (left: SourceEventCursor, right: SourceEventCursor): boolean => left.commit_txid === right.commit_txid && left.event_id === right.event_id;
const afterCursor = (left: SourceEventCursor, right: SourceEventCursor): boolean =>
  BigInt(left.commit_txid) > BigInt(right.commit_txid) || left.commit_txid === right.commit_txid && left.event_id > right.event_id;
const conflict = (cursor: SourceEventCursor): SourceEventDeliveryResult =>
  ({ status: 409, body: { error: { code: "cursor_conflict", cursor } } });

class RevisionConflict extends Error {
  constructor(readonly cursor: SourceEventCursor) { super("revision identity conflict"); }
}

/** A delivery, its captures, and its cursor position commit together. */
export async function deliverSourceEvent(db: Database, tenant: TenantScope, delivery: CommittedEventDelivery,
  context: ProjectionContext): Promise<SourceEventDeliveryResult> {
  try {
    return await withTenant(db, tenant, async (trx) => {
      const current = await lockSourceCursor(trx, tenant);
      if (!sameCursor(current, delivery.previous) || !afterCursor(delivery.cursor, current)) return conflict(current);
      const { event, event_id, run_id, cursor } = delivery;
      for (const capture of selectCaptures(delivery)) {
        const result = await captureInTransaction(trx, capture);
        if (result.kind === "revision_identity_conflict") throw new RevisionConflict(current);
        if (result.kind === "captured") await projectRevisionInTransaction(trx, tenant, capture.revision_id, context);
      }
      await trx.insertInto("observation.source_event_outcome").values({ producer: tenant.producer, namespace: tenant.namespace,
        event_id, run_id, commit_txid: sql<number>`${cursor.commit_txid}::bigint`,
        event_kind: event.kind === "other" ? event.event_kind : event.kind === "revisions" ? "revision_published" : "launched",
        outcome_kind: event.kind, detail: jsonText(event as unknown as JsonValue) })
        .onConflict((target) => target.columns(["producer", "namespace", "event_id"]).doNothing()).execute();
      await sql`UPDATE observation.source_event_cursor SET commit_txid = ${cursor.commit_txid}::bigint, event_id = ${event_id}
        WHERE producer = ${tenant.producer} AND namespace = ${tenant.namespace}`.execute(trx);
      return { status: 200, body: { cursor } };
    });
  } catch (error) {
    if (error instanceof RevisionConflict) return conflict(error.cursor);
    throw error;
  }
}
