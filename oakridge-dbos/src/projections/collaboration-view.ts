import type { CollaborationDeliveryRecord, CollaborationMessageRow, CollaborationThreadRow, ReviewItemRow } from "../domain/delegated-session";

export interface CollaborationThreadView {
  readonly id: string;
  readonly run_id: string;
  readonly scope_id: string;
  readonly artifact_revision_id: string;
  readonly context: CollaborationThreadRow["context"];
  readonly created_at: string;
  readonly capabilities: { readonly can_write: boolean };
  readonly messages: readonly CollaborationMessageRow[];
  readonly review_items: readonly ReviewItemRow[];
  readonly deliveries: readonly CollaborationDeliveryRecord[];
  readonly last_delivery_failure_reason: string | null;
}

export interface ThreadWithCurrent extends CollaborationThreadRow { readonly current_revision_id: string | null }
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
