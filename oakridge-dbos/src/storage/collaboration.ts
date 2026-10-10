import type { SqlExecutor } from "./sql-executor";
import type { TransactionalSqlExecutor } from "./sql-executor";
import type { CollaborationMessageBody, CollaborationThreadContext, ReviewItemBody } from "./json-column-types";
import type { CollaborationThreadRow, CollaborationMessageRow, ReviewItemRow, CollaborationDeliveryRecord } from "../domain/delegated-session";
import { createHash } from "node:crypto";
import { selectCollaborationThreadView, type CollaborationThreadView, type ThreadWithCurrent } from "../projections/collaboration-view";

/** The linear artifact_revision predecessor chain, as stored by the authority. */
export interface RevisionCollaborationNode {
  readonly id: string;
  readonly predecessor_id: string | null;
  readonly execution_id: string | null;
}

/** Nearest agent-produced revision reachable from the reviewed revision. */
export interface RevisionCollaborationTarget {
  readonly revision_id: string;
  readonly execution_id: string;
}

export function revisionCollaborationTarget(reviewed_revision_id: string,
  revisions: readonly RevisionCollaborationNode[]): RevisionCollaborationTarget | null {
  const by_id = new Map(revisions.map((revision) => [revision.id, revision]));
  const visited = new Set<string>();
  let id: string | null = reviewed_revision_id;
  while (id !== null && !visited.has(id)) {
    visited.add(id);
    const revision: RevisionCollaborationNode | undefined = by_id.get(id);
    if (!revision) return null;
    if (revision.execution_id !== null) return { revision_id: revision.id, execution_id: revision.execution_id };
    id = revision.predecessor_id;
  }
  return null;
}

export async function readRevisionCollaborationTarget(db: SqlExecutor, run_id: string,
  reviewed_revision_id: string): Promise<RevisionCollaborationTarget | null> {
  const rows = await db.query<RevisionCollaborationNode>(`WITH RECURSIVE predecessors AS (
    SELECT id,predecessor_id,execution_id,0 AS depth FROM authority.artifact_revision WHERE run_id=$1 AND id=$2
    UNION ALL
    SELECT r.id,r.predecessor_id,r.execution_id,p.depth+1 FROM authority.artifact_revision r
      JOIN predecessors p ON r.id=p.predecessor_id WHERE r.run_id=$1
  ) SELECT id,predecessor_id,execution_id FROM predecessors ORDER BY depth`, [run_id, reviewed_revision_id]);
  return revisionCollaborationTarget(reviewed_revision_id, rows);
}

export type { CollaborationThreadRow, CollaborationMessageRow, ReviewItemRow, CollaborationDeliveryRecord } from "../domain/delegated-session";
export type CollaborationWriteResult<T> = { readonly kind: "written" | "replayed"; readonly value: T }
  | { readonly kind: "missing" | "superseded" | "conflict" };

export function collaborationRecordId(thread_id: string, request_key: string): string {
  return createHash("sha256").update(JSON.stringify([thread_id, request_key])).digest("hex");
}

interface RevisionAddress { readonly run_id: string; readonly scope_id: string; readonly output_key: string; readonly collection_key: string }
async function currentRevision(tx: SqlExecutor, revision_id: string): Promise<{ readonly address: RevisionAddress; readonly is_current: boolean } | null> {
  const rows = await tx.query<RevisionAddress & { readonly current_revision_id: string | null }>(`SELECT r.run_id,r.scope_id,r.output_key,r.collection_key,s.current_revision_id
    FROM authority.artifact_revision r JOIN authority.output_slot s
      ON s.scope_id=r.scope_id AND s.output_key=r.output_key AND s.collection_key=r.collection_key
    WHERE r.id=$1 FOR UPDATE OF s`, [revision_id]);
  const row = rows[0];
  return row ? { address: row, is_current: row.current_revision_id === revision_id } : null;
}

export async function createCollaborationThread(db: TransactionalSqlExecutor, input: {
  readonly id: string; readonly run_id: string; readonly scope_id: string;
  readonly revision_id: string; readonly context: CollaborationThreadContext;
}): Promise<CollaborationWriteResult<CollaborationThreadRow>> {
  return db.transaction(async (tx) => {
    const existing = (await tx.query<CollaborationThreadRow>("SELECT id,run_id,scope_id,artifact_revision_id,context,created_at::text AS created_at FROM authority.collaboration_thread WHERE id=$1", [input.id]))[0];
    if (existing) return existing.run_id === input.run_id && existing.scope_id === input.scope_id
      && existing.artifact_revision_id === input.revision_id && JSON.stringify(existing.context) === JSON.stringify(input.context)
      ? { kind: "replayed", value: existing } : { kind: "conflict" };
    const revision = await currentRevision(tx, input.revision_id);
    if (!revision || revision.address.run_id !== input.run_id || revision.address.scope_id !== input.scope_id) return { kind: "missing" };
    if (!revision.is_current) return { kind: "superseded" };
    const row = (await tx.query<CollaborationThreadRow>(`INSERT INTO authority.collaboration_thread
      (id,run_id,scope_id,artifact_revision_id,context) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (id) DO NOTHING RETURNING id,run_id,scope_id,artifact_revision_id,context,created_at::text AS created_at`,
      [input.id,input.run_id,input.scope_id,input.revision_id,JSON.stringify(input.context)]))[0];
    if (!row) {
      const concurrent = (await tx.query<CollaborationThreadRow>("SELECT id,run_id,scope_id,artifact_revision_id,context,created_at::text AS created_at FROM authority.collaboration_thread WHERE id=$1",[input.id]))[0];
      return concurrent?.run_id === input.run_id && concurrent.scope_id === input.scope_id
        && concurrent.artifact_revision_id === input.revision_id && JSON.stringify(concurrent.context) === JSON.stringify(input.context)
        ? { kind: "replayed", value: concurrent } : { kind: "conflict" };
    }
    return { kind: "written", value: row };
  });
}

async function writableThread(tx: SqlExecutor, run_id: string, scope_id: string, thread_id: string): Promise<{
  readonly kind: "current" | "superseded"; readonly thread: CollaborationThreadRow
} | null> {
  const thread = (await tx.query<CollaborationThreadRow>("SELECT id,run_id,scope_id,artifact_revision_id,context,created_at::text AS created_at FROM authority.collaboration_thread WHERE id=$1 AND run_id=$2 AND scope_id=$3", [thread_id,run_id,scope_id]))[0];
  if (!thread) return null;
  const revision = await currentRevision(tx, thread.artifact_revision_id);
  return { kind: revision?.is_current ? "current" : "superseded", thread };
}

export async function addCollaborationMessage(db: TransactionalSqlExecutor, input: {
  readonly id: string; readonly run_id: string; readonly scope_id: string;
  readonly thread_id: string; readonly body: CollaborationMessageBody;
}): Promise<CollaborationWriteResult<CollaborationMessageRow>> {
  return db.transaction(async (tx) => {
    const existing = (await tx.query<CollaborationMessageRow>("SELECT id,run_id,scope_id,thread_id,body,created_at::text AS created_at FROM authority.collaboration_message WHERE id=$1", [input.id]))[0];
    if (existing) return existing.run_id === input.run_id && existing.thread_id === input.thread_id
      && JSON.stringify(existing.body) === JSON.stringify(input.body)
      ? { kind: "replayed", value: existing } : { kind: "conflict" };
    const writable = await writableThread(tx, input.run_id, input.scope_id, input.thread_id);
    if (!writable) return { kind: "missing" };
    if (writable.kind === "superseded") return { kind: "superseded" };
    const row = (await tx.query<CollaborationMessageRow>(`INSERT INTO authority.collaboration_message
      (id,run_id,scope_id,thread_id,body) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (id) DO NOTHING RETURNING id,run_id,scope_id,thread_id,body,created_at::text AS created_at`,
      [input.id,input.run_id,input.scope_id,input.thread_id,JSON.stringify(input.body)]))[0];
    if (!row) {
      const concurrent = (await tx.query<CollaborationMessageRow>("SELECT id,run_id,scope_id,thread_id,body,created_at::text AS created_at FROM authority.collaboration_message WHERE id=$1",[input.id]))[0];
      return concurrent?.run_id === input.run_id && concurrent.thread_id === input.thread_id
        && JSON.stringify(concurrent.body) === JSON.stringify(input.body)
        ? { kind: "replayed", value: concurrent } : { kind: "conflict" };
    }
    return { kind: "written", value: row };
  });
}

export async function addReviewItem(db: TransactionalSqlExecutor, input: {
  readonly id: string; readonly run_id: string; readonly scope_id: string;
  readonly thread_id: string; readonly body: ReviewItemBody;
}): Promise<CollaborationWriteResult<ReviewItemRow>> {
  return db.transaction(async (tx) => {
    const existing = (await tx.query<ReviewItemRow>("SELECT id,run_id,scope_id,artifact_revision_id,thread_id,body,created_at::text AS created_at FROM authority.review_item WHERE id=$1", [input.id]))[0];
    if (existing) return existing.run_id === input.run_id && existing.thread_id === input.thread_id
      && JSON.stringify(existing.body) === JSON.stringify(input.body)
      ? { kind: "replayed", value: existing } : { kind: "conflict" };
    const writable = await writableThread(tx, input.run_id, input.scope_id, input.thread_id);
    if (!writable) return { kind: "missing" };
    if (writable.kind === "superseded") return { kind: "superseded" };
    const row = (await tx.query<ReviewItemRow>(`INSERT INTO authority.review_item
      (id,run_id,scope_id,artifact_revision_id,thread_id,body) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (id) DO NOTHING RETURNING id,run_id,scope_id,artifact_revision_id,thread_id,body,created_at::text AS created_at`,
      [input.id,input.run_id,input.scope_id,writable.thread.artifact_revision_id,input.thread_id,JSON.stringify(input.body)]))[0];
    if (!row) {
      const concurrent = (await tx.query<ReviewItemRow>("SELECT id,run_id,scope_id,artifact_revision_id,thread_id,body,created_at::text AS created_at FROM authority.review_item WHERE id=$1",[input.id]))[0];
      return concurrent?.run_id === input.run_id && concurrent.thread_id === input.thread_id
        && JSON.stringify(concurrent.body) === JSON.stringify(input.body)
        ? { kind: "replayed", value: concurrent } : { kind: "conflict" };
    }
    return { kind: "written", value: row };
  });
}

export async function findCollaborationDelivery(db: SqlExecutor, id: string): Promise<CollaborationDeliveryRecord | null> {
  return (await db.query<CollaborationDeliveryRecord>("SELECT id,run_id,scope_id,message_id,payload,created_at::text AS created_at FROM authority.collaboration_delivery WHERE id=$1", [id]))[0] ?? null;
}
export async function recordCollaborationDelivery(db: SqlExecutor, input: Omit<CollaborationDeliveryRecord,"created_at">): Promise<CollaborationDeliveryRecord> {
  const rows = await db.query<CollaborationDeliveryRecord>(`INSERT INTO authority.collaboration_delivery
    (id,run_id,scope_id,message_id,payload) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (id) DO NOTHING RETURNING id,run_id,scope_id,message_id,payload,created_at::text AS created_at`, [input.id,input.run_id,input.scope_id,input.message_id,JSON.stringify(input.payload)]);
  return rows[0] ?? (await findCollaborationDelivery(db,input.id))!;
}

/** Current-revision reads include predecessor threads so superseded review remains visible and read-only. */
export async function readCollaborationThreads(db: SqlExecutor, run_id: string, scope_id: string,
  revision_id: string): Promise<readonly CollaborationThreadView[]> {
  const threads = await db.query<ThreadWithCurrent>(`WITH RECURSIVE chain AS (
    SELECT id,predecessor_id,0 AS depth FROM authority.artifact_revision
      WHERE run_id=$1 AND scope_id=$2 AND id=$3
    UNION ALL
    SELECT r.id,r.predecessor_id,chain.depth+1 FROM authority.artifact_revision r
      JOIN chain ON r.id=chain.predecessor_id WHERE r.run_id=$1 AND r.scope_id=$2
  ) SELECT t.id,t.run_id,t.scope_id,t.artifact_revision_id,t.context,
    t.created_at::text AS created_at,s.current_revision_id FROM authority.collaboration_thread t
    JOIN chain ON chain.id=t.artifact_revision_id
    JOIN authority.artifact_revision r ON r.id=t.artifact_revision_id
    JOIN authority.output_slot s ON s.scope_id=r.scope_id AND s.output_key=r.output_key AND s.collection_key=r.collection_key
    WHERE t.run_id=$1 AND t.scope_id=$2 ORDER BY chain.depth DESC,t.created_at,t.id`, [run_id,scope_id,revision_id]);
  return Promise.all(threads.map(async (thread) => {
    const [messages, review_items, deliveries] = await Promise.all([
      db.query<CollaborationMessageRow>(`SELECT id,run_id,scope_id,thread_id,body,created_at::text AS created_at
        FROM authority.collaboration_message WHERE thread_id=$1 ORDER BY created_at,id`, [thread.id]),
      db.query<ReviewItemRow>(`SELECT id,run_id,scope_id,artifact_revision_id,thread_id,body,created_at::text AS created_at
        FROM authority.review_item WHERE thread_id=$1 ORDER BY created_at,id`, [thread.id]),
      db.query<CollaborationDeliveryRecord>(`SELECT d.id,d.run_id,d.scope_id,d.message_id,d.payload,d.created_at::text AS created_at
        FROM authority.collaboration_delivery d JOIN authority.collaboration_message m ON m.id=d.message_id
        WHERE m.thread_id=$1 ORDER BY d.created_at DESC,d.id DESC`, [thread.id]),
    ]);
    return selectCollaborationThreadView(thread,messages,review_items,deliveries);
  }));
}
