import type { Kysely, Selectable } from "kysely";
import type { Event } from "../core-client/core-types";
import type { AuthorityCollaborationMessage, AuthorityCollaborationThread, AuthorityReviewDecision, DB } from "./db-types";
import { jsonText } from "./database";

export interface BackfillCursor { readonly created_at: string; readonly id: string }
export interface ReviewDecisionBatchRow { readonly decision: Selectable<AuthorityReviewDecision>;
  readonly archived_at: Date | null }
export interface CollaborationThreadBatchRow { readonly thread: Selectable<AuthorityCollaborationThread>;
  readonly archived_at: Date | null; readonly messages: readonly Selectable<AuthorityCollaborationMessage>[] }

export async function readReviewDecisionRows(db: Kysely<DB>, cursor: BackfillCursor,
  limit: number): Promise<readonly ReviewDecisionBatchRow[]> {
  const rows = await db.selectFrom("authority.review_decision as d")
    .innerJoin("authority.run as r", "r.id", "d.run_id")
    .selectAll("d").select("r.archived_at")
    .where((eb) => eb(eb.refTuple("d.created_at", "d.id"), ">", eb.tuple(new Date(cursor.created_at), cursor.id)))
    .orderBy("d.created_at").orderBy("d.id").limit(limit).execute();
  return rows.map(({ archived_at, ...decision }) => ({ decision, archived_at }));
}

export async function readCollaborationThreadRows(db: Kysely<DB>, cursor: BackfillCursor,
  limit: number): Promise<readonly CollaborationThreadBatchRow[]> {
  const rows = await db.selectFrom("authority.collaboration_thread as t")
    .innerJoin("authority.run as r", "r.id", "t.run_id")
    .selectAll("t").select("r.archived_at")
    .where((eb) => eb(eb.refTuple("t.created_at", "t.id"), ">", eb.tuple(new Date(cursor.created_at), cursor.id)))
    .orderBy("t.created_at").orderBy("t.id").limit(limit).execute();
  const batch: CollaborationThreadBatchRow[] = [];
  for (const { archived_at, ...thread } of rows) {
    const messages = await db.selectFrom("authority.collaboration_message").selectAll()
      .where("run_id", "=", thread.run_id).where("thread_id", "=", thread.id)
      .orderBy("created_at").orderBy("id").execute();
    batch.push({ thread, archived_at, messages });
  }
  return batch;
}

export async function findDecisionEventId(db: Kysely<DB>, decision: Selectable<AuthorityReviewDecision>): Promise<string | null> {
  const event: Event = { kind: "operator_decided", unit: decision.unit_id, review: decision.review,
    decision: decision.decision, target: decision.target_revision_id, payload: decision.payload };
  const rows = await db.selectFrom("authority.event").select(["id", "created_at"])
    .where("run_id", "=", decision.run_id).where("payload", "=", event)
    .orderBy("created_at").orderBy("id").execute();
  const nearest = rows.reduce<(typeof rows)[number] | null>((best, row) => !best
    || Math.abs(row.created_at.getTime() - decision.created_at.getTime())
      < Math.abs(best.created_at.getTime() - decision.created_at.getTime()) ? row : best, null);
  return nearest?.id ?? null;
}

export async function readDecisionForEvent(db: Kysely<DB>, run_id: string,
  event: Extract<Event, { kind: "operator_decided" }>, created_at: Date): Promise<Selectable<AuthorityReviewDecision> | null> {
  const rows = await db.selectFrom("authority.review_decision").selectAll()
    .where("run_id", "=", run_id).where("unit_id", "=", event.unit)
    .where("review", "=", event.review).where("decision", "=", event.decision)
    .where("target_revision_id", "=", event.target).where("payload", "=", jsonText(event.payload))
    .orderBy("created_at", "desc").execute();
  return rows.find((decision) => decision.created_at <= created_at) ?? null;
}

export async function readOperatorRunState(db: Kysely<DB>, event_id: string): Promise<{ readonly run_key: string;
  readonly run_exists: boolean }> {
  const row = await db.selectFrom("authority.operator_event").select("run_key").where("id", "=", event_id).executeTakeFirstOrThrow();
  const run = await db.selectFrom("authority.run").select("id").where("id", "=", row.run_key).executeTakeFirst();
  return { run_key: row.run_key, run_exists: !!run };
}
