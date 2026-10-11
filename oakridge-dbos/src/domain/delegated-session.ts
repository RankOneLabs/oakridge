import type { StageOperatorRole } from "./workflow";
import type { CollaborationDeliveryPayload, CollaborationMessageBody, CollaborationThreadContext, ReviewItemBody } from "../storage/json-column-types";

/**
 * Adapter-owned name for why a role is being launched. Core carries the name
 * but does not close over an adapter's vocabulary.
 */
type SessionLaunchReasonName = string;

/** Durable reference from a session to the transition that launched it. */
interface SessionLaunchReason {
  readonly transition_id: import("./primitives").RunTransitionId;
  readonly name: SessionLaunchReasonName;
}

/** Immutable launch material selected by, and readable from, one transition. */
export interface CommittedSessionLaunch {
  readonly reason: SessionLaunchReason;
  readonly session_role: StageOperatorRole;
  readonly prompt: { readonly template_path: string; readonly content: string };
  readonly existing_pull_request: string | null;
}

/** Collaboration rows mirror authority.collaboration_* and authority.review_item. */
export interface CollaborationThreadRow {
  readonly id: string; readonly run_id: string; readonly scope_id: string;
  readonly artifact_revision_id: string; readonly context: CollaborationThreadContext;
  readonly created_at: string;
}
export interface CollaborationMessageRow {
  readonly id: string; readonly run_id: string; readonly scope_id: string;
  readonly thread_id: string; readonly body: CollaborationMessageBody; readonly created_at: string;
}
export interface ReviewItemRow {
  readonly id: string; readonly run_id: string; readonly scope_id: string;
  readonly thread_id: string; readonly artifact_revision_id: string;
  readonly body: ReviewItemBody; readonly created_at: string;
}
export interface CollaborationDeliveryRecord {
  readonly id: string; readonly run_id: string; readonly scope_id: string; readonly message_id: string;
  readonly payload: CollaborationDeliveryPayload;
  readonly created_at: string;
}
