import { sql, type Selectable } from "kysely";
import type { JsonValue } from "../domain/primitives";
import { decodeCapture, type CaptureDelivery, type CaptureEnvelope } from "../ingest/capture";
import type { SourceEventAck, SourceEventCursor, SourceEventDelivery, SourceEventOutcome } from "../ingest/cursor";
import { INITIAL_SOURCE_CURSOR } from "../ingest/cursor";
import { jsonText, withTenant, type Database, type DatabaseTransaction, type TenantScope } from "./database";
import type { ObservationSourceRevision } from "./db-types";
import { recordedRevisionIds, declareRelationInTransaction, lockSourceCursor, projectRevisionInTransaction, type ProjectionContext } from "./projection-store";

export interface SourceRevisionRead {
  readonly id: string;
  readonly producer: string;
  readonly namespace: string;
  readonly run_id: string;
  readonly unit_id: string;
  readonly stage: string;
  readonly revision_id: string;
  readonly artifact_kind: string;
  readonly artifact_schema_version: string;
  readonly definition_id: string;
  readonly body: JsonValue;
  readonly body_digest: string;
  readonly predecessor_id: string | null;
  readonly subject_id: string | null;
  readonly recorded_at: string;
  readonly captured_at: string;
}
export type CaptureOutcome =
  | { readonly kind: "captured" }
  /** A later event repeated a revision already held with the same identity and content. */
  | { readonly kind: "identical" }
  | { readonly kind: "revision_identity_conflict"; readonly stored_digest: string; readonly incoming_digest: string };

function sourceRead(row: Selectable<ObservationSourceRevision>): SourceRevisionRead {
  const id = `${row.producer}:${row.namespace}:${row.revision_id}`;
  const prefix = `${row.producer}:${row.namespace}:`;
  return { id, producer: row.producer, namespace: row.namespace, run_id: row.run_id, unit_id: row.unit_id, stage: row.stage,
    revision_id: id, artifact_kind: row.artifact_kind, artifact_schema_version: row.artifact_schema_version,
    definition_id: row.definition_id,
    body: row.body, body_digest: row.body_digest,
    predecessor_id: row.predecessor_id ? `${prefix}${row.predecessor_id}` : null,
    subject_id: row.subject_id ? `${prefix}${row.subject_id}` : null,
    recorded_at: row.recorded_at.toISOString(), captured_at: row.captured_at.toISOString() };
}

/** A revision id names one immutable body: a repeat is harmless, a different body is refused. */
export async function captureInTransaction(trx: DatabaseTransaction, delivery: CaptureDelivery): Promise<CaptureOutcome> {
  const { source, body, body_digest, recorded_at }: CaptureEnvelope = delivery.envelope;
  const { producer, namespace } = source;
  const revision_id = delivery.local_revision_id;
  const prefix = `${producer}:${namespace}:`;
  const predecessor_id = source.predecessor_id?.slice(prefix.length) ?? null;
  const subject_id = source.subject_id?.slice(prefix.length) ?? null;
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${producer}:${namespace}:revision:${revision_id}`}, 0))`.execute(trx);
  const existing = await trx.selectFrom("observation.source_revision").selectAll()
    .where("producer", "=", producer).where("namespace", "=", namespace).where("revision_id", "=", revision_id).executeTakeFirst();
  const stored_ids = existing ? await recordedRevisionIds(trx, { producer, namespace }, revision_id, "brief_revision_ids") : null;
  const incoming_ids = source.brief_revision_ids?.map((id) => id.slice(prefix.length)) ?? null;
  const same_provenance = JSON.stringify(stored_ids) === JSON.stringify(incoming_ids);
  if (same_provenance && existing?.body_digest === body_digest && existing.predecessor_id === predecessor_id && existing.subject_id === subject_id && existing.stage === source.stage)
    return { kind: "identical" };
  if (existing) return { kind: "revision_identity_conflict", stored_digest: existing.body_digest, incoming_digest: body_digest };
  await trx.insertInto("observation.source_revision").values({ producer, namespace, revision_id,
    run_id: source.run_id, unit_id: source.unit_id, stage: source.stage, artifact_kind: source.artifact_kind,
    artifact_schema_version: source.artifact_schema_version, definition_id: source.definition_id, body: jsonText(body),
    body_digest, predecessor_id, subject_id, recorded_at: new Date(recorded_at) }).execute();
  return { kind: "captured" };
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

/** A declared source this service holds no item for: the relation cannot exist, and this keeps it visible. */
export interface UnresolvedDeclaredSource { readonly source_revision_id: string; readonly item_path: string; readonly detail: string }
/** What a delivered declaration projected to. Stored with the outcome, in the delivery's transaction. */
export interface DeclarationProjection { readonly relation_ids: readonly string[]; readonly unresolved_sources: readonly UnresolvedDeclaredSource[] }
export type StoredRelationDeclaration = Extract<SourceEventOutcome, { readonly kind: "relation_declaration" }> & { readonly projection: DeclarationProjection };

/** The outcome a delivery records: a declaration's relations are written here, under the cursor lock
 * and in the cursor's own transaction, so they and the advance commit or vanish together. */
async function applyDeclaration(trx: DatabaseTransaction, tenant: TenantScope, outcome: Extract<SourceEventOutcome, { readonly kind: "relation_declaration" }>,
  context: ProjectionContext): Promise<SourceEventOutcome | StoredRelationDeclaration> {
  const declared = context.extraction.declaredRelations(outcome.declaration, outcome.run_id);
  if (!declared.ok) return { format: outcome.format, definition_id: outcome.definition_id, artifact_schema_version: outcome.artifact_schema_version,
    kind: "unmapped", event_kind: outcome.event_kind, run_id: outcome.run_id, event_id: outcome.event_id,
    reason: `${declared.error.entity_id}: ${declared.error.detail}` };
  const relation_ids = new Set<string>();
  const unresolved_sources: UnresolvedDeclaredSource[] = [];
  for (const declaration of declared.value) {
    const applied = await declareRelationInTransaction(trx, tenant, declaration);
    if (applied.ok) relation_ids.add(applied.value);
    else unresolved_sources.push({ source_revision_id: declaration.source_revision_id, item_path: declaration.item_path, detail: applied.error.detail });
  }
  return { ...outcome, projection: { relation_ids: [...relation_ids], unresolved_sources } };
}

export interface SourceEventConflict { readonly error: { readonly code: "cursor_conflict"; readonly cursor: SourceEventCursor } }
export interface SourceEventDeliveryResult { readonly status: 200 | 409; readonly body: SourceEventAck | SourceEventConflict }
const sameCursor = (left: SourceEventCursor, right: SourceEventCursor): boolean => left.commit_txid === right.commit_txid && left.id === right.id;
const afterCursor = (left: SourceEventCursor, right: SourceEventCursor): boolean =>
  BigInt(left.commit_txid) > BigInt(right.commit_txid) || left.commit_txid === right.commit_txid && left.id > right.id;

/** Store the outcome and advance the tenant cursor in the same transaction. */
export function deliverSourceEvent(db: Database, tenant: TenantScope, delivery: SourceEventDelivery,
  context: ProjectionContext): Promise<SourceEventDeliveryResult> {
  return withTenant(db, tenant, async (trx) => {
    const current = await lockSourceCursor(trx, tenant);
    const conflict: SourceEventDeliveryResult = { status: 409, body: { error: { code: "cursor_conflict", cursor: current } } };
    if (!sameCursor(current, delivery.previous) || !afterCursor(delivery.cursor, current)) return conflict;
    let outcome: SourceEventOutcome | StoredRelationDeclaration = delivery.outcome;
    if (outcome.kind === "relation_declaration") outcome = await applyDeclaration(trx, tenant, outcome, context);
    else if (outcome.kind === "artifact_revision") {
      const decoded = decodeCapture(outcome.revision);
      if (!decoded.ok) return conflict;
      outcome = { ...outcome, revision: decoded.value.envelope };
      const source = outcome.revision.source;
      if (source.producer !== tenant.producer || source.namespace !== tenant.namespace || source.run_id !== outcome.run_id) return conflict;
      const local_revision_id = source.revision_id.slice(`${tenant.producer}:${tenant.namespace}:`.length);
      const captured = await captureInTransaction(trx, { envelope: outcome.revision, local_revision_id });
      if (captured.kind === "revision_identity_conflict") return conflict;

    }
    await trx.insertInto("observation.source_event_outcome").values({ producer: tenant.producer, namespace: tenant.namespace,
      event_id: outcome.event_id, run_id: outcome.run_id, commit_txid: sql<number>`${delivery.cursor.commit_txid}::bigint`,
      event_kind: outcome.event_kind, outcome_kind: outcome.kind, detail: jsonText(outcome as unknown as JsonValue) })
      .onConflict((target) => target.columns(["producer", "namespace", "event_id"]).doNothing()).execute();
    if (outcome.kind === "artifact_revision") await projectRevisionInTransaction(trx, tenant,
      outcome.revision.source.revision_id.slice(`${tenant.producer}:${tenant.namespace}:`.length), context);
    await sql`UPDATE observation.source_event_cursor SET commit_txid = ${delivery.cursor.commit_txid}::bigint, event_id = ${delivery.cursor.id}
      WHERE producer = ${tenant.producer} AND namespace = ${tenant.namespace}`.execute(trx);
    return { status: 200, body: { cursor: delivery.cursor } };
  });
}

/** The declarations delivered for one run, oldest first, each with what it projected to. */
export function readRelationDeclarations(db: Database, tenant: TenantScope, run_id: string): Promise<readonly StoredRelationDeclaration[]> {
  return withTenant(db, tenant, async (trx) => {
    const rows = await trx.selectFrom("observation.source_event_outcome").select("detail")
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace).where("run_id", "=", run_id)
      .where("outcome_kind", "=", "relation_declaration").orderBy("commit_txid").orderBy("event_id").execute();
    return rows.map((row) => row.detail as unknown as StoredRelationDeclaration);
  });
}

export interface UnmappedPage { readonly items: readonly SourceEventOutcome[]; readonly total: number; readonly limit: number; readonly offset: number }
export function readUnmappedSourceEvents(db: Database, tenant: TenantScope, page: { readonly limit: number; readonly offset: number }): Promise<UnmappedPage> {
  return withTenant(db, tenant, async (trx) => {
    const unmapped = trx.selectFrom("observation.source_event_outcome").where("producer", "=", tenant.producer)
      .where("namespace", "=", tenant.namespace).where("outcome_kind", "=", "unmapped");
    const count = await unmapped.select((eb) => eb.fn.countAll<string>().as("count")).executeTakeFirstOrThrow();
    const rows = await unmapped.select("detail").orderBy("commit_txid").orderBy("event_id").limit(page.limit).offset(page.offset).execute();
    return { items: rows.map((row) => row.detail as unknown as SourceEventOutcome), total: Number(count.count), ...page };
  });
}
