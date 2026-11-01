import { sql, type Selectable } from "kysely";
import type { JsonValue } from "../domain/primitives";
import { canonicalDigest } from "../canonical/canonical-json";
import type { CaptureDelivery } from "../ingest/capture";
import type { SourceEventAck, SourceEventCursor, SourceEventDelivery, SourceEventOutcome } from "../ingest/cursor";
import { INITIAL_SOURCE_CURSOR } from "../ingest/cursor";
import { jsonText, withTenant, type Database, type DatabaseTransaction, type TenantScope } from "./database";
import type { ObservationSourceRevision } from "./db-types";
import { projectRevisionInTransaction } from "./projection-store";
import { storeCollaborationInTransaction, storeHumanGradeInTransaction } from "./backfill-store";

export type SourceEventIssueCause = "missing_grade_target" | "missing_collaboration_revision" | "run_mismatch"
  | "unmapped_event" | "revision_identity_conflict" | "tenant_mismatch";
export interface SourceEventIssue { readonly issue_id: string; readonly event_id: string; readonly run_id: string;
  readonly event_kind: string; readonly target_revision_id: string | null; readonly cause: SourceEventIssueCause;
  readonly resolution_state: "unresolved" | "resolved"; readonly resolution_detail: string | null }
function sourceIssueId(tenant: TenantScope, outcome: SourceEventOutcome, cause: SourceEventIssueCause): string {
  const digest = canonicalDigest([tenant.producer, tenant.namespace, outcome.event_id, cause]);
  if (!digest.ok) throw new Error(digest.error.detail);
  return digest.value;
}
async function recordSourceIssue(trx: DatabaseTransaction, tenant: TenantScope, outcome: SourceEventOutcome,
  cause: SourceEventIssueCause, target_revision_id: string | null): Promise<SourceEventIssue> {
  const issue_id = sourceIssueId(tenant, outcome, cause);
  await trx.insertInto("observation.source_event_issue").values({ ...tenant, issue_id,
    event_id: outcome.event_id, run_id: outcome.run_id, event_kind: outcome.event_kind, target_revision_id, cause,
    original_outcome: jsonText(outcome as unknown as JsonValue), resolution_state: "unresolved", resolution_detail: null,
    resolved_at: null }).onConflict((conflict) => conflict.columns(["producer", "namespace", "issue_id"]).doNothing()).execute();
  return { issue_id, event_id: outcome.event_id, run_id: outcome.run_id, event_kind: outcome.event_kind,
    target_revision_id, cause, resolution_state: "unresolved", resolution_detail: null };
}

export interface SourceRevisionRead {
  readonly id: string;
  readonly producer: string;
  readonly namespace: string;
  readonly run_id: string;
  readonly unit_id: string;
  readonly revision_id: string;
  readonly artifact_kind: string;
  readonly artifact_schema_version: string;
  readonly definition_id: string | null;
  readonly collection_key: string | null;
  readonly definition_bundle_id: string | null;
  readonly definition_bundle_digest: string | null;
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
    definition_id: row.definition_id, collection_key: row.collection_key,
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
  if (receipt) {
    if (receipt.incoming_digest !== body_digest) return { status: 409, body: { error: {
      code: "revision_identity_conflict", revision_id: source.revision_id,
      stored_digest: receipt.stored_digest, incoming_digest: body_digest } } };
    return receiptOutcome(receipt.outcome, receipt.response);
  }
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${producer}:${namespace}:revision:${revision_id}`}, 0))`.execute(trx);
  const existing = await trx.selectFrom("observation.source_revision").selectAll()
    .where("producer", "=", producer).where("namespace", "=", namespace).where("revision_id", "=", revision_id).executeTakeFirst();
  if (existing?.body_digest === body_digest && existing.predecessor_id === predecessor_id && existing.subject_id === subject_id
    && existing.run_id === source.run_id && existing.unit_id === source.unit_id
    && existing.artifact_kind === source.artifact_kind && existing.artifact_schema_version === source.artifact_schema_version
    && existing.definition_bundle_id === source.definition_bundle.id
    && existing.definition_bundle_digest === source.definition_bundle.digest) {
    const first = await trx.selectFrom("observation.ingest_receipt").selectAll()
      .where("producer", "=", producer).where("namespace", "=", namespace).where("revision_id", "=", revision_id)
      .where("outcome", "=", "captured").orderBy("recorded_at", "asc").executeTakeFirstOrThrow();
    return receiptOutcome(first.outcome, first.response);
  }
  if (existing) {
    const response: ConflictResponse = { error: { code: "revision_identity_conflict", revision_id: source.revision_id,
      stored_digest: existing.body_digest, incoming_digest: body_digest } };
    await trx.insertInto("observation.ingest_receipt").values({ producer, namespace, request_key: delivery.request_key,
      revision_id, outcome: "revision_identity_conflict", response: jsonText(response as unknown as JsonValue),
      stored_digest: existing.body_digest, incoming_digest: body_digest }).execute();
    return { status: 409, body: response };
  }
  const row = await trx.insertInto("observation.source_revision").values({ producer, namespace, revision_id,
    run_id: source.run_id, unit_id: source.unit_id, artifact_kind: source.artifact_kind,
    artifact_schema_version: source.artifact_schema_version, collection_key: source.collection_key ?? null,
    definition_bundle_id: source.definition_bundle.id,
    // Serialized explicitly: pg sends a JS string as-is, so a scalar body (a markdown spec) would reach jsonb unquoted.
    definition_bundle_digest: source.definition_bundle.digest, body: jsonText(body),
    body_digest, predecessor_id, subject_id, recorded_at: new Date(recorded_at) })
    .returningAll().executeTakeFirstOrThrow();
  await hooks.afterMirror?.();
  const response: CaptureResponse = { source_revision: sourceRead(row) };
  await trx.insertInto("observation.ingest_receipt").values({ producer, namespace, request_key: delivery.request_key,
    revision_id, outcome: "captured", response: jsonText(response as unknown as JsonValue),
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
export interface SourceEventDeliveryResult { readonly status: 200 | 409; readonly body: (SourceEventAck & { readonly issue?: SourceEventIssue }) | SourceEventConflict }
const sameCursor = (left: SourceEventCursor, right: SourceEventCursor): boolean => left.commit_txid === right.commit_txid && left.id === right.id;
const afterCursor = (left: SourceEventCursor, right: SourceEventCursor): boolean =>
  BigInt(left.commit_txid) > BigInt(right.commit_txid) || left.commit_txid === right.commit_txid && left.id > right.id;

/** Production mapping and writers shared by delivery and repair. Known gaps become durable issues. */
export async function applySourceOutcomeInTransaction(trx: DatabaseTransaction, tenant: TenantScope,
  outcome: SourceEventOutcome): Promise<SourceEventIssue | null> {
  if (outcome.kind === "artifact_revision") {
    const source = outcome.revision.source;
    if (source.producer !== tenant.producer || source.namespace !== tenant.namespace)
      return recordSourceIssue(trx, tenant, outcome, "tenant_mismatch", source.revision_id);
    if (source.run_id !== outcome.run_id)
      return recordSourceIssue(trx, tenant, outcome, "run_mismatch", source.revision_id);
    const result = await captureInTransaction(trx, { request_key: outcome.event_id, envelope: outcome.revision,
      local_revision_id: source.revision_id.slice(`${tenant.producer}:${tenant.namespace}:`.length) });
    if (result.status !== 201) return recordSourceIssue(trx, tenant, outcome, "revision_identity_conflict", source.revision_id);
    const revision_id = source.revision_id.slice(`${tenant.producer}:${tenant.namespace}:`.length);
    if (source.collection_key !== undefined && source.collection_key !== null) {
      const current = await trx.selectFrom("observation.source_revision").select("collection_key")
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("revision_id", "=", revision_id).executeTakeFirstOrThrow();
      if (current.collection_key !== null && current.collection_key !== source.collection_key)
        throw new Error(`source revision ${revision_id} collection relationship conflict`);
      if (current.collection_key === null) await trx.updateTable("observation.source_revision")
        .set({ collection_key: source.collection_key })
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("revision_id", "=", revision_id).execute();
    }
    await projectRevisionInTransaction(trx, tenant, revision_id);
    await reconcileSourceEventIssuesInTransaction(trx, tenant, revision_id);
    return null;
  }
  if (outcome.kind === "human_grade" || outcome.kind === "collaboration_thread") {
    const target = outcome.kind === "human_grade" ? outcome.target : outcome.revision_id;
    if (target) {
      const revision = await trx.selectFrom("observation.source_revision").select("run_id")
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("revision_id", "=", target).executeTakeFirst();
      if (!revision) return recordSourceIssue(trx, tenant, outcome,
        outcome.kind === "human_grade" ? "missing_grade_target" : "missing_collaboration_revision", target);
      if (revision.run_id !== outcome.run_id) return recordSourceIssue(trx, tenant, outcome, "run_mismatch", target);
    }
    if (outcome.kind === "human_grade") await storeHumanGradeInTransaction(trx, tenant, outcome);
    else await storeCollaborationInTransaction(trx, tenant, outcome);
    return null;
  }
  if (outcome.kind === "unmapped") return recordSourceIssue(trx, tenant, outcome, "unmapped_event", null);
  return null;
}

/** A newly captured target retries the original outcome through the production writer once. */
export async function reconcileSourceEventIssuesInTransaction(trx: DatabaseTransaction, tenant: TenantScope,
  target_revision_id: string): Promise<number> {
  const rows = await trx.selectFrom("observation.source_event_issue").selectAll()
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("target_revision_id", "=", target_revision_id).where("resolution_state", "=", "unresolved")
    .where("cause", "in", ["missing_grade_target", "missing_collaboration_revision"]).execute();
  let resolved = 0;
  for (const row of rows) {
    const outcome = row.original_outcome as unknown as SourceEventOutcome;
    if (outcome.kind === "human_grade") await storeHumanGradeInTransaction(trx, tenant, outcome);
    else if (outcome.kind === "collaboration_thread") await storeCollaborationInTransaction(trx, tenant, outcome);
    else continue;
    await trx.updateTable("observation.source_event_issue").set({ resolution_state: "resolved",
      resolution_detail: "target captured and projection retried", resolved_at: new Date() })
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("issue_id", "=", row.issue_id).execute();
    resolved++;
  }
  return resolved;
}

export function readSourceEventIssues(db: Database, tenant: TenantScope, offset = 0): Promise<readonly SourceEventIssue[]> {
  return withTenant(db, tenant, async (trx) => trx.selectFrom("observation.source_event_issue")
    .select(["issue_id", "event_id", "run_id", "event_kind", "target_revision_id", "cause", "resolution_state", "resolution_detail"])
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .orderBy("recorded_at").orderBy("issue_id").limit(500).offset(offset).execute() as Promise<readonly SourceEventIssue[]>);
}

/** Repair invokes the same mapping writers but never changes either live position. */
export function repairSourceEvent(db: Database, tenant: TenantScope, outcome: SourceEventOutcome,
  commit_txid: string): Promise<"repaired" | "purged" | "unchanged"> {
  return withTenant(db, tenant, async (trx) => {
    const purged = await trx.selectFrom("observation.purge_event").select("purge_id")
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("run_id", "=", outcome.run_id).executeTakeFirst();
    if (purged) return "purged";
    const existing = await trx.selectFrom("observation.source_event_outcome").select("detail")
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("event_id", "=", outcome.event_id).executeTakeFirst();
    if (existing) {
      const old = canonicalDigest(existing.detail);
      const incoming = canonicalDigest(outcome as unknown as JsonValue);
      if (!old.ok || !incoming.ok) throw new Error(`source event ${outcome.event_id} content is not canonical`);
      if (old.value !== incoming.value) {
        const previous = existing.detail as unknown as SourceEventOutcome;
        if (previous.kind !== "unmapped" || outcome.kind === "unmapped")
          throw new Error(`source event ${outcome.event_id} content conflict`);
        await trx.updateTable("observation.source_event_outcome").set({ outcome_kind: outcome.kind,
          detail: jsonText(outcome as unknown as JsonValue) })
          .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
          .where("event_id", "=", outcome.event_id).execute();
        await trx.updateTable("observation.source_event_issue").set({ resolution_state: "resolved",
          resolution_detail: "mapping corrected and event retried", resolved_at: new Date() })
          .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
          .where("event_id", "=", outcome.event_id).where("cause", "=", "unmapped_event").execute();
      }
    }
    const issue = await applySourceOutcomeInTransaction(trx, tenant, outcome);
    if (!issue) await trx.updateTable("observation.source_event_issue").set({ resolution_state: "resolved",
      resolution_detail: "repair retried original outcome", resolved_at: new Date() })
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("event_id", "=", outcome.event_id)
      .where("cause", "in", ["missing_grade_target", "missing_collaboration_revision"]).execute();
    if (!existing) await trx.insertInto("observation.source_event_outcome").values({ ...tenant,
      event_id: outcome.event_id, run_id: outcome.run_id, commit_txid: sql<number>`${commit_txid}::bigint`,
      event_kind: outcome.event_kind, outcome_kind: outcome.kind,
      detail: jsonText(outcome as unknown as JsonValue) }).execute();
    if (outcome.kind === "human_grade") await trx.insertInto("observation.source_human_grade").values({ ...tenant,
      event_id: outcome.event_id, run_id: outcome.run_id, unit_id: outcome.unit, review: outcome.review,
      decision: outcome.decision, target_revision_id: outcome.target, evaluator_kind: "human",
      feedback: jsonText(outcome.feedback as JsonValue) })
      .onConflict((conflict) => conflict.columns(["producer", "namespace", "event_id"]).doNothing()).execute();
    return existing ? "unchanged" : "repaired";
  });
}

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
    const prior = await trx.selectFrom("observation.source_event_outcome").select("detail")
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("event_id", "=", outcome.event_id).executeTakeFirst();
    if (prior) {
      const old = canonicalDigest(prior.detail);
      const incoming = canonicalDigest(outcome as unknown as JsonValue);
      if (!old.ok || !incoming.ok || old.value !== incoming.value)
        throw new Error(`source event ${outcome.event_id} content conflict`);
    }
    const issue = await applySourceOutcomeInTransaction(trx, tenant, outcome);
    await trx.insertInto("observation.source_event_outcome").values({ producer: tenant.producer, namespace: tenant.namespace,
      event_id: outcome.event_id, run_id: outcome.run_id, commit_txid: sql<number>`${delivery.cursor.commit_txid}::bigint`,
      event_kind: outcome.event_kind, outcome_kind: outcome.kind, detail: jsonText(outcome as unknown as JsonValue) })
      .onConflict((conflict) => conflict.columns(["producer", "namespace", "event_id"]).doNothing()).execute();
    if (outcome.kind === "human_grade") {
      await trx.insertInto("observation.source_human_grade").values({ producer: tenant.producer, namespace: tenant.namespace,
        event_id: outcome.event_id, run_id: outcome.run_id, unit_id: outcome.unit, review: outcome.review,
        decision: outcome.decision, target_revision_id: outcome.target, evaluator_kind: "human",
        feedback: jsonText(outcome.feedback as JsonValue) })
        .onConflict((conflict) => conflict.columns(["producer", "namespace", "event_id"]).doNothing()).execute();
    }
    await sql`UPDATE observation.source_event_cursor SET commit_txid = ${delivery.cursor.commit_txid}::bigint, event_id = ${delivery.cursor.id}
      WHERE producer = ${tenant.producer} AND namespace = ${tenant.namespace}`.execute(trx);
    return { status: 200, body: { cursor: delivery.cursor, ...(issue ? { issue } : {}) } };
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
