import type { SqlExecutor } from "../storage/sql-executor";
import type { CollaborationDeliveryRecord, CollaborationMessageRow, CollaborationThreadRow, ReviewItemRow } from "../storage/collaboration";

export interface CollaborationThreadView {
  readonly id: string;
  readonly run_id: string;
  readonly scope_id: string;
  readonly artifact_revision_id: string;
  readonly context: CollaborationThreadRow["context"];
  readonly created_at: Date;
  readonly capabilities: { readonly can_write: boolean };
  readonly messages: readonly CollaborationMessageRow[];
  readonly review_items: readonly ReviewItemRow[];
  readonly deliveries: readonly CollaborationDeliveryRecord[];
  readonly last_delivery_failure_reason: string | null;
}

interface ThreadWithCurrent extends CollaborationThreadRow { readonly current_revision_id: string | null }
export function selectCollaborationThreadView(thread: ThreadWithCurrent,
  messages: readonly CollaborationMessageRow[], review_items: readonly ReviewItemRow[],
  deliveries: readonly CollaborationDeliveryRecord[]): CollaborationThreadView {
  const latest_delivery = deliveries[0];
  return { id: thread.id, run_id: thread.run_id, scope_id: thread.scope_id,
    artifact_revision_id: thread.artifact_revision_id, context: thread.context, created_at: thread.created_at,
    capabilities: { can_write: thread.artifact_revision_id === thread.current_revision_id },
    messages, review_items, deliveries, last_delivery_failure_reason: latest_delivery?.payload.status === "failed"
      ? latest_delivery.payload.reason : null };
}

export async function readCollaborationThreads(db: SqlExecutor, run_id: string, scope_id: string,
  revision_id: string): Promise<readonly CollaborationThreadView[]> {
  const threads = await db.query<ThreadWithCurrent>(`SELECT t.*,s.current_revision_id FROM authority.collaboration_thread t
    JOIN authority.artifact_revision r ON r.id=t.artifact_revision_id
    JOIN authority.output_slot s ON s.scope_id=r.scope_id AND s.output_key=r.output_key AND s.collection_key=r.collection_key
    WHERE t.run_id=$1 AND t.scope_id=$2 AND t.artifact_revision_id=$3 ORDER BY t.created_at,t.id`, [run_id,scope_id,revision_id]);
  return Promise.all(threads.map(async (thread) => {
    const [messages, review_items, deliveries] = await Promise.all([
      db.query<CollaborationMessageRow>("SELECT * FROM authority.collaboration_message WHERE thread_id=$1 ORDER BY created_at,id", [thread.id]),
      db.query<ReviewItemRow>("SELECT * FROM authority.review_item WHERE thread_id=$1 ORDER BY created_at,id", [thread.id]),
      db.query<CollaborationDeliveryRecord>(`SELECT d.* FROM authority.collaboration_delivery d
        JOIN authority.collaboration_message m ON m.id=d.message_id WHERE m.thread_id=$1 ORDER BY d.created_at DESC,d.id DESC`, [thread.id]),
    ]);
    return selectCollaborationThreadView(thread,messages,review_items,deliveries);
  }));
}
