import { sql, type Selectable } from "kysely";
import type { JsonValue } from "../domain/primitives";
import type { CaptureDelivery } from "../ingest/capture";
import type { SourceEventAck, SourceEventCursor, SourceEventDelivery, SourceEventOutcome } from "../ingest/cursor";
import { INITIAL_SOURCE_CURSOR } from "../ingest/cursor";
import { withTenant, type Database, type DatabaseTransaction, type TenantScope } from "./database";
import type { ObservationSourceRevision } from "./db-types";
import { projectRevisionInTransaction } from "./projection-store";
import { storeHumanGradeInTransaction } from "./backfill-store";

export interface SourceRevisionRead {
  readonly id: string;
  readonly producer: string;
  readonly namespace: string;
  readonly run_id: string;
  readonly unit_id: string;
  readonly revision_id: string;
  readonly artifact_kind: string;
  readonly artifact_schema_version: string;
  readonly definition_bundle_id: string;
  readonly definition_bundle_digest: string;
  readonly body: JsonValue;
  readonly body_digest: string;
  readonly predecessor_id: string | null;
  readonly subject_id: string | null;
  readonly recorded_at: string;
  readonly captured_at: string;
}
export interface CaptureResponse { readonly source_revision: SourceRevisionRead }
export interface ConflictResponse { readonly error: { readonly code: "revision_identity_conflict"; readonly revision_id: string; readonly stored_digest: string; readonly incoming_digest: string } }
export type DeliveryResponse = CaptureResponse | ConflictResponse;
export interface DeliveryOutcome { readonly status: 201 | 409; readonly body: DeliveryResponse }
export interface CaptureHooks { readonly afterMirror?: () => Promise<void> }

function sourceRead(row: Selectable<ObservationSourceRevision>): SourceRevisionRead {
  const id = `${row.producer}:${row.namespace}:${row.revision_id}`;
  const prefix = `${row.producer}:${row.namespace}:`;
  return { id, producer: row.producer, namespace: row.namespace, run_id: row.run_id, unit_id: row.unit_id,
    revision_id: id, artifact_kind: row.artifact_kind, artifact_schema_version: row.artifact_schema_version,
    definition_bundle_id: row.definition_bundle_id, definition_bundle_digest: row.definition_bundle_digest,
    body: row.body, body_digest: row.body_digest,
    predecessor_id: row.predecessor_id ? `${prefix}${row.predecessor_id}` : null,
    subject_id: row.subject_id ? `${prefix}${row.subject_id}` : null,
    recorded_at: row.recorded_at.toISOString(), captured_at: row.captured_at.toISOString() };
}

function receiptOutcome(outcome: string, response: JsonValue): DeliveryOutcome {
  return { status: outcome === "revision_identity_conflict" ? 409 : 201, body: response as unknown as DeliveryResponse };
}

export async function captureInTransaction(trx: DatabaseTransaction, delivery: CaptureDelivery, hooks: CaptureHooks = {}): Promise<DeliveryOutcome> {
  const { source, body, body_digest, recorded_at } = delivery.envelope;
  const { producer, namespace } = source;
  const revision_id = delivery.local_revision_id;
  const prefix = `${producer}:${namespace}:`;
  const predecessor_id = source.predecessor_id?.slice(prefix.length) ?? null;
  const subject_id = source.subject_id?.slice(prefix.length) ?? null;
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${producer}:${namespace}:request:${delivery.request_key}`}, 0))`.execute(trx);
  const receipt = await trx.selectFrom("observation.ingest_receipt").selectAll()
    .where("producer", "=", producer).where("namespace", "=", namespace).where("request_key", "=", delivery.request_key).executeTakeFirst();
  if (receipt) return receiptOutcome(receipt.outcome, receipt.response);
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${producer}:${namespace}:revision:${revision_id}`}, 0))`.execute(trx);
  const existing = await trx.selectFrom("observation.source_revision").selectAll()
    .where("producer", "=", producer).where("namespace", "=", namespace).where("revision_id", "=", revision_id).executeTakeFirst();
  if (existing?.body_digest === body_digest && existing.predecessor_id === predecessor_id && existing.subject_id === subject_id) {
    const first = await trx.selectFrom("observation.ingest_receipt").selectAll()
      .where("producer", "=", producer).where("namespace", "=", namespace).where("revision_id", "=", revision_id)
      .where("outcome", "=", "captured").orderBy("recorded_at", "asc").executeTakeFirstOrThrow();
    return receiptOutcome(first.outcome, first.response);
  }
  if (existing) {
    const response: ConflictResponse = { error: { code: "revision_identity_conflict", revision_id: source.revision_id,
      stored_digest: existing.body_digest, incoming_digest: body_digest } };
    await trx.insertInto("observation.ingest_receipt").values({ producer, namespace, request_key: delivery.request_key,
      revision_id, outcome: "revision_identity_conflict", response: response as unknown as JsonValue,
      stored_digest: existing.body_digest, incoming_digest: body_digest }).execute();
    return { status: 409, body: response };
  }
  const row = await trx.insertInto("observation.source_revision").values({ producer, namespace, revision_id,
    run_id: source.run_id, unit_id: source.unit_id, artifact_kind: source.artifact_kind,
    artifact_schema_version: source.artifact_schema_version, definition_bundle_id: source.definition_bundle.id,
    definition_bundle_digest: source.definition_bundle.digest, body, body_digest, predecessor_id, subject_id,
    recorded_at: new Date(recorded_at) })
    .returningAll().executeTakeFirstOrThrow();
  await hooks.afterMirror?.();
  const response: CaptureResponse = { source_revision: sourceRead(row) };
  await trx.insertInto("observation.ingest_receipt").values({ producer, namespace, request_key: delivery.request_key,
    revision_id, outcome: "captured", response: response as unknown as JsonValue,
    stored_digest: body_digest, incoming_digest: body_digest }).execute();
  return { status: 201, body: response };
}

export function captureDelivery(db: Database, delivery: CaptureDelivery, hooks: CaptureHooks = {}): Promise<DeliveryOutcome> {
  const { producer, namespace } = delivery.envelope.source;
  return withTenant(db, { producer, namespace }, (trx) => captureInTransaction(trx, delivery, hooks));
}

/** Every read runs with the credential's tenant context and an explicit tenant predicate. */
export function readSourceRevision(db: Database, tenant: TenantScope, identity: string): Promise<SourceRevisionRead | null> {
  const prefix = `${tenant.producer}:${tenant.namespace}:`;
  if (!identity.startsWith(prefix) || identity.length === prefix.length) return Promise.resolve(null);
  return withTenant(db, tenant, async (trx) => {
    const row = await trx.selectFrom("observation.source_revision").selectAll()
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("revision_id", "=", identity.slice(prefix.length)).executeTakeFirst();
    return row ? sourceRead(row) : null;
  });
}

export function readSourceCursor(db: Database, tenant: TenantScope): Promise<SourceEventAck> {
  return withTenant(db, tenant, async (trx) => {
    const row = await sql<SourceEventCursor>`SELECT commit_txid::text AS commit_txid, event_id AS id
      FROM observation.source_event_cursor WHERE producer = ${tenant.producer} AND namespace = ${tenant.namespace}`.execute(trx);
    return { cursor: row.rows[0] ?? INITIAL_SOURCE_CURSOR };
  });
}

export interface SourceEventConflict { readonly error: { readonly code: "cursor_conflict"; readonly cursor: SourceEventCursor } }
export interface SourceEventDeliveryResult { readonly status: 200 | 409; readonly body: SourceEventAck | SourceEventConflict }
const sameCursor = (left: SourceEventCursor, right: SourceEventCursor): boolean => left.commit_txid === right.commit_txid && left.id === right.id;
const afterCursor = (left: SourceEventCursor, right: SourceEventCursor): boolean =>
  BigInt(left.commit_txid) > BigInt(right.commit_txid) || left.commit_txid === right.commit_txid && left.id > right.id;

/** Store the outcome and advance the tenant cursor in the same transaction. */
export function deliverSourceEvent(db: Database, tenant: TenantScope, delivery: SourceEventDelivery): Promise<SourceEventDeliveryResult> {
  return withTenant(db, tenant, async (trx) => {
    await sql`INSERT INTO observation.source_event_cursor (producer, namespace) VALUES (${tenant.producer}, ${tenant.namespace})
      ON CONFLICT DO NOTHING`.execute(trx);
    const selected = await sql<SourceEventCursor>`SELECT commit_txid::text AS commit_txid, event_id AS id
      FROM observation.source_event_cursor WHERE producer = ${tenant.producer} AND namespace = ${tenant.namespace} FOR UPDATE`.execute(trx);
    const current = selected.rows[0] ?? INITIAL_SOURCE_CURSOR;
    if (!sameCursor(current, delivery.previous)) {
      return { status: 409, body: { error: { code: "cursor_conflict", cursor: current } } };
    }
    if (!afterCursor(delivery.cursor, current)) return { status: 409, body: { error: { code: "cursor_conflict", cursor: current } } };
    const outcome: SourceEventOutcome = delivery.outcome;
    if (outcome.kind === "artifact_revision") {
      const source = outcome.revision.source;
      if (source.producer !== tenant.producer || source.namespace !== tenant.namespace || source.run_id !== outcome.run_id)
        return { status: 409, body: { error: { code: "cursor_conflict", cursor: current } } };
      const result = await captureInTransaction(trx, { request_key: outcome.event_id, envelope: outcome.revision,
        local_revision_id: source.revision_id.slice(`${tenant.producer}:${tenant.namespace}:`.length) });
      if (result.status !== 201) return { status: 409, body: { error: { code: "cursor_conflict", cursor: current } } };
      await projectRevisionInTransaction(trx, tenant, source.revision_id.slice(`${tenant.producer}:${tenant.namespace}:`.length));
    }
    await trx.insertInto("observation.source_event_outcome").values({ producer: tenant.producer, namespace: tenant.namespace,
      event_id: outcome.event_id, run_id: outcome.run_id, commit_txid: sql<number>`${delivery.cursor.commit_txid}::bigint`,
      event_kind: outcome.event_kind, outcome_kind: outcome.kind, detail: outcome as unknown as JsonValue })
      .onConflict((conflict) => conflict.columns(["producer", "namespace", "event_id"]).doNothing()).execute();
    if (outcome.kind === "human_grade") {
      await storeHumanGradeInTransaction(trx, tenant, outcome);
      await trx.insertInto("observation.source_human_grade").values({ producer: tenant.producer, namespace: tenant.namespace,
        event_id: outcome.event_id, run_id: outcome.run_id, unit_id: outcome.unit, review: outcome.review,
        decision: outcome.decision, target_revision_id: outcome.target, evaluator_kind: "human",
        feedback: outcome.feedback as JsonValue | null })
        .onConflict((conflict) => conflict.columns(["producer", "namespace", "event_id"]).doNothing()).execute();
    }
    await sql`UPDATE observation.source_event_cursor SET commit_txid = ${delivery.cursor.commit_txid}::bigint, event_id = ${delivery.cursor.id}
      WHERE producer = ${tenant.producer} AND namespace = ${tenant.namespace}`.execute(trx);
    return { status: 200, body: { cursor: delivery.cursor } };
  });
}

export function readUnmappedSourceEvents(db: Database, tenant: TenantScope): Promise<readonly SourceEventOutcome[]> {
  return withTenant(db, tenant, async (trx) => {
    const rows = await trx.selectFrom("observation.source_event_outcome").select("detail")
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("outcome_kind", "=", "unmapped").orderBy("commit_txid").orderBy("event_id").execute();
    return rows.map((row) => row.detail as unknown as SourceEventOutcome);
  });
}

export function readSourceHumanGrades(db: Database, tenant: TenantScope): Promise<readonly SourceEventOutcome[]> {
  return withTenant(db, tenant, async (trx) => {
    const rows = await trx.selectFrom("observation.source_event_outcome").select("detail")
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("outcome_kind", "=", "human_grade").orderBy("commit_txid").orderBy("event_id").execute();
    return rows.map((row) => row.detail as unknown as SourceEventOutcome);
  });
}
