import type { CollaborationMessageBody, CollaborationThreadContext, ReviewItemBody } from "../storage/json-column-types";

/** Collaboration rows mirror authority.collaboration_* and authority.review_item. */
export interface CollaborationThreadRow {
  readonly id: string; readonly run_id: string; readonly unit_id: string;
  readonly artifact_revision_id: string; readonly context: CollaborationThreadContext;
  readonly created_at: string;
}
export interface CollaborationMessageRow {
  readonly id: string; readonly run_id: string; readonly unit_id: string;
  readonly thread_id: string; readonly body: CollaborationMessageBody; readonly created_at: string;
}
export interface ReviewItemRow {
  readonly id: string; readonly run_id: string; readonly unit_id: string;
  readonly thread_id: string; readonly artifact_revision_id: string;
  readonly body: ReviewItemBody; readonly created_at: string;
}
