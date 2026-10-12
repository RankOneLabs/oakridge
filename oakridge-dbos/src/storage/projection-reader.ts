import type { Workflow } from "../core-client/core-types";
import type { SqlExecutor, TransactionalSqlExecutor } from "./sql-executor";
import type { RunEventCursor } from "../projections/run-event";
import type { OperatorEventDeliveryRow } from "../projections/operator-event";
import type { ArtifactRevisionRecord, ProjectRecord, ReviewItemRecord, RunId, RunRecord, UnitId, UnitRecord } from "./schema-records";
import { isTerminalStatus, selectArtifactSchemas, selectAvailableDecisions, type UnitView } from "../projections/unit-view";
import { selectInboxItems, type InboxPage, type InboxRow } from "../projections/inbox";
import type { RunView } from "../projections/run-view";

/** The pinned workflow a run is executing. */
async function pinnedWorkflow(tx: SqlExecutor, run_id: string): Promise<{ readonly source: Workflow; readonly digest: string } | null> {
  return (await tx.query<{ source: Workflow; digest: string }>(
    "SELECT b.source,b.digest FROM authority.definition_bundle b JOIN authority.run r ON r.definition_bundle_id=b.id WHERE r.id=$1", [run_id]))[0] ?? null;
}

export async function readUnitView(db: TransactionalSqlExecutor, run_id: RunId, unit_id: UnitId): Promise<UnitView | null> {
  return db.transaction(async (tx) => {
    const unit = (await tx.query<UnitRecord>("SELECT * FROM authority.unit WHERE run_id=$1 AND id=$2", [run_id, unit_id]))[0];
    if (!unit) return null;
    const pinned = await pinnedWorkflow(tx, unit.run_id);
    if (!pinned) throw new Error(`pinned definition missing for ${unit.run_id}`);
    const [revisions, open_reviews, latest_event] = await Promise.all([
      tx.query<ArtifactRevisionRecord>("SELECT * FROM authority.artifact_revision WHERE run_id=$1 AND unit_id=$2 ORDER BY created_at,id", [run_id, unit_id]),
      tx.query<ReviewItemRecord>("SELECT * FROM authority.review_item WHERE run_id=$1 AND unit_id=$2 AND body->>'status'='open' ORDER BY created_at,id", [run_id, unit_id]),
      tx.query<{ id: string }>("SELECT id FROM authority.event WHERE run_id=$1 AND unit_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1", [run_id, unit_id]),
    ]);
    return { run_id: unit.run_id, unit_id: unit.id, unit_key: unit.declaration, stage: unit.stage,
      status: unit.status, version: Number(unit.version), revisions, open_reviews,
      decisions: selectAvailableDecisions(pinned.source, unit.stage),
      artifact_schemas: selectArtifactSchemas(pinned.source, unit.stage),
      cursor: { unit_version: Number(unit.version), event_id: latest_event[0]?.id ?? null } };
  }, "repeatable read");
}

export const DEFAULT_INBOX_LIMIT = 100;
export interface InboxQuery { readonly run_id?: RunId; readonly cursor?: string; readonly limit?: number }
interface InboxUnitRow extends Omit<InboxRow, "source" | "open_reviews"> { readonly definition_bundle_id: string; readonly open_reviews: readonly ReviewItemRecord[] | null }
export async function readInbox(db: TransactionalSqlExecutor, query: InboxQuery = {}): Promise<InboxPage> {
  const limit = Math.min(Math.max(1, query.limit ?? DEFAULT_INBOX_LIMIT), DEFAULT_INBOX_LIMIT);
  const after = query.cursor ? JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")) as readonly [string, string] : null;
  if (after && (!Array.isArray(after) || after.length !== 2 || after.some((item) => typeof item !== "string"))) throw new Error("invalid inbox cursor");
  return db.transaction(async (tx) => {
    const rows = await tx.query<InboxUnitRow>(`SELECT u.*, r.definition_bundle_id,
      (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.created_at,i.id) FROM authority.review_item i
        WHERE i.run_id=u.run_id AND i.unit_id=u.id AND i.body->>'status'='open') AS open_reviews
      FROM authority.unit u JOIN authority.run r ON r.id=u.run_id
      WHERE ($1::text IS NULL OR u.run_id=$1) AND ($2::text IS NULL OR (u.run_id,u.id)>($2,$3))
      ORDER BY u.run_id,u.id LIMIT $4`, [query.run_id ?? null, after?.[0] ?? null, after?.[1] ?? null, limit + 1]);
    const page = rows.slice(0, limit);
    const bundle_ids = [...new Set(page.map((row) => row.definition_bundle_id))];
    const bundles = bundle_ids.length ? await tx.query<{ id: string; source: Workflow }>(
      "SELECT id,source FROM authority.definition_bundle WHERE id=ANY($1::text[])", [bundle_ids]) : [];
    const sources = new Map(bundles.map((bundle) => [bundle.id, bundle.source]));
    const last = page.at(-1);
    return { cursor: page.map((row) => ({ unit_id: row.id, version: Number(row.version) })),
      items: page.flatMap((row) => selectInboxItems({ ...row, source: sources.get(row.definition_bundle_id) ?? null })),
      next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify([last.run_id, last.id])).toString("base64url") : null };
  }, "repeatable read");
}

export async function readRunView(db: TransactionalSqlExecutor, run_id: RunId): Promise<RunView | null> {
  return db.transaction(async (tx) => {
    const run = (await tx.query<RunRecord>("SELECT * FROM authority.run WHERE id=$1", [run_id]))[0];
    if (!run) return null;
    const pinned = await pinnedWorkflow(tx, run_id);
    if (!pinned) throw new Error(`pinned definition missing for ${run_id}`);
    const units = await tx.query<UnitRecord>("SELECT * FROM authority.unit WHERE run_id=$1 ORDER BY id", [run_id]);
    return { run_id, definition_bundle_id: run.definition_bundle_id, definition_digest: pinned.digest, version: Number(run.version),
      created_at: run.created_at, archived_at: run.archived_at,
      cursor: units.map((unit) => ({ unit_id: unit.id, version: Number(unit.version) })),
      units: units.map((unit) => ({ unit_id: unit.id, unit_key: unit.declaration,
        label: unit.stage ?? unit.declaration, version: Number(unit.version),
        is_terminal: isTerminalStatus(unit.status),
        available_decisions: selectAvailableDecisions(pinned.source, unit.stage).map((item) => item.decision) })) };
  }, "repeatable read");
}

/** Saved projects for the operator, by name. */
export async function listProjects(db: TransactionalSqlExecutor): Promise<readonly ProjectRecord[]> {
  return db.query<ProjectRecord>("SELECT * FROM authority.project ORDER BY name,id", []);
}

/**
 * Operator events after the cursor in writing-transaction order, limited to
 * transactions older than every one still open: those are all committed or
 * gone, so no later commit can land behind the cursor.
 */
export async function readOperatorEventsAfter(db: TransactionalSqlExecutor, after: RunEventCursor, limit: number, subscription_snapshot: string | null = null): Promise<readonly OperatorEventDeliveryRow[]> {
  return db.query<OperatorEventDeliveryRow>(`SELECT e.id,e.event_key,e.payload,e.commit_txid::text AS commit_txid,
      CASE WHEN $4::pg_snapshot IS NULL THEN false ELSE pg_visible_in_snapshot(e.commit_txid::text::xid8,$4::pg_snapshot) END AS was_visible_at_subscription
    FROM authority.operator_event e
    WHERE (e.commit_txid,e.id)>($1::bigint,$2::text) AND e.commit_txid<pg_snapshot_xmin(pg_current_snapshot())::text::bigint
    ORDER BY e.commit_txid,e.id LIMIT $3`, [after.commit_txid, after.id, limit, subscription_snapshot]);
}
export interface EventStreamBoundary { readonly cursor: RunEventCursor; readonly snapshot: string }
/** Capture one snapshot for the safe starting cursor and reconnect replay classification. */
export async function readEventStreamBoundary(db: TransactionalSqlExecutor): Promise<EventStreamBoundary> {
  const row = (await db.query<{ commit_txid: string; snapshot: string }>(
    "WITH boundary AS MATERIALIZED (SELECT pg_current_snapshot() AS snapshot) SELECT pg_snapshot_xmin(snapshot)::text AS commit_txid,snapshot::text AS snapshot FROM boundary", []))[0];
  if (!row) throw new Error("current snapshot unavailable");
  return { cursor: { commit_txid: row.commit_txid, id: "" }, snapshot: row.snapshot };
}
