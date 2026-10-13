import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import type { CollaborationDeliveryRecord, CollaborationMessageRow, CollaborationThreadRow, ReviewItemRow } from "../domain/delegated-session";
import { selectCollaborationThreadView, type CollaborationThreadView } from "../projections/collaboration-view";
import type { DB } from "./db-types";
import { anyOf, jsonText, type Database, type DatabaseTransaction } from "./database";
import type { CollaborationDeliveryPayload, CollaborationMessageBody, CollaborationThreadContext, ReviewItemBody } from "./json-column-types";

type Reader = Kysely<DB> | DatabaseTransaction;

export type CollaborationWriteResult<T> = { readonly kind: "written" | "replayed"; readonly value: T }
  | { readonly kind: "missing" | "superseded" | "conflict" };

/** A collaboration record's id is derived from its parent and the caller's request key, so a retry replays. */
export function collaborationRecordId(parent_id: string, request_key: string): string {
  return createHash("sha256").update(JSON.stringify([parent_id, request_key])).digest("hex");
}

const createdAt = (value: Date): string => new Date(value).toISOString();
const threadRow = (row: { id: string; run_id: string; unit_id: string; artifact_revision_id: string | null; context: CollaborationThreadContext; created_at: Date }): CollaborationThreadRow | null =>
  row.artifact_revision_id === null ? null : { ...row, artifact_revision_id: row.artifact_revision_id, created_at: createdAt(row.created_at) };

/**
 * Where a revision sits in its artifact's history. The run row is share-locked
 * so commit cannot publish a newer revision between this check and the write.
 */
async function revisionStanding(trx: DatabaseTransaction, run_id: string, revision_id: string):
  Promise<{ readonly unit_id: string; readonly is_latest: boolean } | null> {
  await trx.selectFrom("authority.run").select("id").where("id", "=", run_id).forShare().execute();
  const revision = await trx.selectFrom("authority.artifact_revision").select(["unit_id", "artifact"])
    .where("run_id", "=", run_id).where("id", "=", revision_id).executeTakeFirst();
  if (!revision) return null;
  const latest = await trx.selectFrom("authority.artifact_revision").select("id")
    .where("run_id", "=", run_id).where("unit_id", "=", revision.unit_id).where("artifact", "=", revision.artifact)
    .orderBy("created_at", "desc").orderBy("id", "desc").executeTakeFirst();
  return { unit_id: revision.unit_id, is_latest: latest?.id === revision_id };
}

export interface ThreadInput {
  readonly id: string; readonly run_id: string; readonly unit_id: string;
  readonly revision_id: string; readonly context: CollaborationThreadContext;
}
/** A thread opens on the latest revision of an artifact; a superseded revision's threads are read-only. */
export async function createCollaborationThread(db: Database, input: ThreadInput): Promise<CollaborationWriteResult<CollaborationThreadRow>> {
  const matches = (row: CollaborationThreadRow): boolean => row.run_id === input.run_id && row.unit_id === input.unit_id
    && row.artifact_revision_id === input.revision_id && JSON.stringify(row.context) === JSON.stringify(input.context);
  return db.transaction().execute(async (trx) => {
    const prior = await readThread(trx, input.id);
    if (prior) return matches(prior) ? { kind: "replayed", value: prior } : { kind: "conflict" };
    const standing = await revisionStanding(trx, input.run_id, input.revision_id);
    if (!standing || standing.unit_id !== input.unit_id) return { kind: "missing" };
    if (!standing.is_latest) return { kind: "superseded" };
    const row = await trx.insertInto("authority.collaboration_thread").values({ id: input.id, run_id: input.run_id, unit_id: input.unit_id,
      artifact_revision_id: input.revision_id, context: jsonText(input.context) }).onConflict((conflict) => conflict.column("id").doNothing())
      .returningAll().executeTakeFirst();
    const written = row ? threadRow(row) : null;
    if (written) return { kind: "written", value: written };
    const concurrent = await readThread(trx, input.id);
    return concurrent && matches(concurrent) ? { kind: "replayed", value: concurrent } : { kind: "conflict" };
  });
}

async function readThread(db: Reader, id: string): Promise<CollaborationThreadRow | null> {
  const row = await db.selectFrom("authority.collaboration_thread").selectAll().where("id", "=", id).executeTakeFirst();
  return row ? threadRow(row) : null;
}

/** A thread accepts writes while its revision is the latest of its artifact. */
async function writableThread(trx: DatabaseTransaction, run_id: string, unit_id: string, thread_id: string):
  Promise<{ readonly kind: "current" | "superseded"; readonly thread: CollaborationThreadRow } | null> {
  const thread = await readThread(trx, thread_id);
  if (!thread || thread.run_id !== run_id || thread.unit_id !== unit_id) return null;
  const standing = await revisionStanding(trx, run_id, thread.artifact_revision_id);
  return { kind: standing?.is_latest ? "current" : "superseded", thread };
}

export interface MessageInput {
  readonly id: string; readonly run_id: string; readonly unit_id: string;
  readonly thread_id: string; readonly body: CollaborationMessageBody;
}
export async function addCollaborationMessage(db: Database, input: MessageInput): Promise<CollaborationWriteResult<CollaborationMessageRow>> {
  const matches = (row: CollaborationMessageRow): boolean => row.run_id === input.run_id && row.unit_id === input.unit_id
    && row.thread_id === input.thread_id && row.body.text === input.body.text && row.body.author === input.body.author
    && (row.body.ping ?? false) === (input.body.ping ?? false);
  return db.transaction().execute(async (trx) => {
    const prior = await readMessage(trx, input.id);
    if (prior) return matches(prior) ? { kind: "replayed", value: prior } : { kind: "conflict" };
    const writable = await writableThread(trx, input.run_id, input.unit_id, input.thread_id);
    if (!writable) return { kind: "missing" };
    if (writable.kind === "superseded") return { kind: "superseded" };
    const row = await trx.insertInto("authority.collaboration_message").values({ id: input.id, run_id: input.run_id, unit_id: input.unit_id,
      thread_id: input.thread_id, body: jsonText(input.body) }).onConflict((conflict) => conflict.column("id").doNothing())
      .returningAll().executeTakeFirst();
    if (row) return { kind: "written", value: { ...row, created_at: createdAt(row.created_at) } };
    const concurrent = await readMessage(trx, input.id);
    return concurrent && matches(concurrent) ? { kind: "replayed", value: concurrent } : { kind: "conflict" };
  });
}

async function readMessage(db: Reader, id: string): Promise<CollaborationMessageRow | null> {
  const row = await db.selectFrom("authority.collaboration_message").selectAll().where("id", "=", id).executeTakeFirst();
  return row ? { ...row, created_at: createdAt(row.created_at) } : null;
}

/** The revision a thread is attached to, when the thread belongs to the run and unit named. */
export async function readThreadRevision(db: Reader, input: { readonly run_id: string; readonly unit_id: string; readonly thread_id: string }): Promise<string | null> {
  const thread = await readThread(db, input.thread_id);
  return thread && thread.run_id === input.run_id && thread.unit_id === input.unit_id ? thread.artifact_revision_id : null;
}

export interface ReviewItemInput {
  readonly id: string; readonly run_id: string; readonly unit_id: string;
  readonly thread_id: string; readonly body: ReviewItemBody;
}
export async function addReviewItem(db: Database, input: ReviewItemInput): Promise<CollaborationWriteResult<ReviewItemRow>> {
  const matches = (row: ReviewItemRow): boolean => row.run_id === input.run_id && row.thread_id === input.thread_id
    && JSON.stringify(row.body) === JSON.stringify(input.body);
  return db.transaction().execute(async (trx) => {
    const prior = await readReviewItem(trx, input.id);
    if (prior) return matches(prior) ? { kind: "replayed", value: prior } : { kind: "conflict" };
    const writable = await writableThread(trx, input.run_id, input.unit_id, input.thread_id);
    if (!writable) return { kind: "missing" };
    if (writable.kind === "superseded") return { kind: "superseded" };
    const row = await trx.insertInto("authority.review_item").values({ id: input.id, run_id: input.run_id, unit_id: input.unit_id,
      artifact_revision_id: writable.thread.artifact_revision_id, thread_id: input.thread_id, body: jsonText(input.body) })
      .onConflict((conflict) => conflict.column("id").doNothing()).returningAll().executeTakeFirst();
    const written = row ? reviewItemRow(row) : null;
    if (written) return { kind: "written", value: written };
    const concurrent = await readReviewItem(trx, input.id);
    return concurrent && matches(concurrent) ? { kind: "replayed", value: concurrent } : { kind: "conflict" };
  });
}

const reviewItemRow = (row: { id: string; run_id: string; unit_id: string; artifact_revision_id: string | null; thread_id: string | null; body: ReviewItemBody; created_at: Date }): ReviewItemRow | null =>
  row.artifact_revision_id === null || row.thread_id === null ? null
    : { ...row, artifact_revision_id: row.artifact_revision_id, thread_id: row.thread_id, created_at: createdAt(row.created_at) };
async function readReviewItem(db: Reader, id: string): Promise<ReviewItemRow | null> {
  const row = await db.selectFrom("authority.review_item").selectAll().where("id", "=", id).executeTakeFirst();
  return row ? reviewItemRow(row) : null;
}

export interface DeliveryInput {
  readonly id: string; readonly run_id: string; readonly unit_id: string;
  readonly message_id: string; readonly payload: CollaborationDeliveryPayload;
}
/**
 * One delivery outcome per id; a repeat returns the outcome first recorded.
 * The run row is share-locked like every other collaboration write, so run
 * deletion either finishes first (null: the run is gone) or waits for it.
 */
export async function recordCollaborationDelivery(db: Database, input: DeliveryInput): Promise<CollaborationDeliveryRecord | null> {
  return db.transaction().execute(async (trx) => {
    const run = await trx.selectFrom("authority.run").select("id").where("id", "=", input.run_id).forShare().executeTakeFirst();
    if (!run) return null;
    const row = await trx.insertInto("authority.collaboration_delivery").values({ ...input, payload: jsonText(input.payload) })
      .onConflict((conflict) => conflict.column("id").doNothing()).returningAll().executeTakeFirst()
      ?? await trx.selectFrom("authority.collaboration_delivery").selectAll().where("id", "=", input.id).executeTakeFirstOrThrow();
    return { ...row, created_at: createdAt(row.created_at) };
  });
}

/** The threads on a revision and on every revision before it, oldest first; only the latest revision's are writable. */
export async function readCollaborationThreads(db: Reader, input: { readonly run_id: string; readonly unit_id: string; readonly revision_id: string }):
  Promise<readonly CollaborationThreadView[]> {
  const chain = await revisionChain(db, input);
  if (chain.length === 0) return [];
  const head = await db.selectFrom("authority.artifact_revision").select(["unit_id", "artifact"])
    .where("run_id", "=", input.run_id).where("id", "=", input.revision_id).executeTakeFirstOrThrow();
  const latest = await db.selectFrom("authority.artifact_revision").select("id").where("run_id", "=", input.run_id)
    .where("unit_id", "=", head.unit_id).where("artifact", "=", head.artifact)
    .orderBy("created_at", "desc").orderBy("id", "desc").executeTakeFirst();
  const depth = new Map(chain.map((id, index) => [id, index]));
  const thread_rows = await db.selectFrom("authority.collaboration_thread").selectAll()
    .where("run_id", "=", input.run_id).where("unit_id", "=", input.unit_id).where("artifact_revision_id", "=", anyOf(chain))
    .orderBy("created_at").orderBy("id").execute();
  const threads = thread_rows.flatMap((row) => { const thread = threadRow(row); return thread ? [thread] : []; })
    .sort((left, right) => (depth.get(right.artifact_revision_id) ?? 0) - (depth.get(left.artifact_revision_id) ?? 0));
  if (threads.length === 0) return [];
  const thread_ids = threads.map((thread) => thread.id);
  const [messages, review_items, deliveries] = await Promise.all([
    db.selectFrom("authority.collaboration_message").selectAll().where("thread_id", "=", anyOf(thread_ids))
      .orderBy("thread_id").orderBy("created_at").orderBy("id").execute(),
    db.selectFrom("authority.review_item").selectAll().where("thread_id", "=", anyOf(thread_ids))
      .orderBy("thread_id").orderBy("created_at").orderBy("id").execute(),
    db.selectFrom("authority.collaboration_delivery as delivery")
      .innerJoin("authority.collaboration_message as message", "message.id", "delivery.message_id")
      .selectAll("delivery").select("message.thread_id").where("message.thread_id", "=", anyOf(thread_ids))
      .orderBy("message.thread_id").orderBy("delivery.created_at", "desc").orderBy("delivery.id", "desc").execute(),
  ]);
  return threads.map((thread) => selectCollaborationThreadView({ ...thread, latest_revision_id: latest?.id ?? null },
    messages.filter((row) => row.thread_id === thread.id).map((row) => ({ ...row, created_at: createdAt(row.created_at) })),
    review_items.flatMap((row) => { const item = row.thread_id === thread.id ? reviewItemRow(row) : null; return item ? [item] : []; }),
    deliveries.filter((row) => row.thread_id === thread.id).map(({ thread_id: _thread, ...row }) => ({ ...row, created_at: createdAt(row.created_at) }))));
}

/** The revision and its predecessors, newest first, within one unit. */
async function revisionChain(db: Reader, input: { readonly run_id: string; readonly unit_id: string; readonly revision_id: string }): Promise<readonly string[]> {
  const chain: string[] = [];
  let id: string | null = input.revision_id;
  while (id !== null && !chain.includes(id)) {
    const revision: { readonly predecessor_id: string | null } | undefined = await db.selectFrom("authority.artifact_revision").select("predecessor_id")
      .where("run_id", "=", input.run_id).where("unit_id", "=", input.unit_id).where("id", "=", id).executeTakeFirst();
    if (!revision) break;
    chain.push(id);
    id = revision.predecessor_id;
  }
  return chain;
}
