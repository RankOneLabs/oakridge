import type { ExternalExecutionReference } from "./execution";
import type { ArtifactId, Brand, CohortId, DeliveryKey, ExecutionId, JsonValue, SessionMessageId, WorkflowRunId } from "./primitives";

export type ThreadId = Brand<string, "ThreadId">;
export type MessageId = Brand<string, "MessageId">;
export type SessionThreadId = Brand<string, "SessionThreadId">;
export type SessionThreadMessageId = Brand<string, "SessionThreadMessageId">;
export type ReviewItemId = Brand<string, "ReviewItemId">;
export type ThreadStatus = "open" | "resolved";
export type ReviewItemStatus = "open" | "resolved" | "waived";
export interface CollaborationThread { readonly id: ThreadId; readonly artifact_id: ArtifactId; readonly revision_id: ArtifactId; readonly anchor: string | null; readonly status: ThreadStatus; readonly created_at: string }
export interface CollaborationMessage { readonly id: MessageId; readonly thread_id: ThreadId; readonly body: string; readonly author: string; readonly created_at: string }
export interface CollaborationThreadWithMessages extends CollaborationThread { readonly messages: readonly CollaborationMessage[] }
export interface ReviewItem { readonly id: ReviewItemId; readonly artifact_id: ArtifactId; readonly revision_id: ArtifactId; readonly anchor: string; readonly claim: string; readonly reality: string; readonly status: ReviewItemStatus; readonly resolution: string | null; readonly created_at: string }
export interface ReviewItemCandidate { readonly anchor: string; readonly claim: string; readonly reality: string }

export interface SessionMessageDeliveryTarget {
  readonly execution_id: ExecutionId;
  readonly executor_type: string;
  readonly external_reference: ExternalExecutionReference;
}

export interface SessionMessage {
  readonly id: SessionMessageId;
  readonly run_id: WorkflowRunId;
  readonly cohort_id: CohortId | null;
  readonly sender: MessageParty;
  readonly recipient: MessageParty;
  readonly thread_id: SessionThreadId;
  readonly message_id: SessionThreadMessageId;
  readonly artifact_thread_id: ThreadId | null;
  readonly body: JsonValue;
  readonly delivery_key: DeliveryKey;
  readonly created_at: string;
}

export interface DeliverSessionMessage {
  readonly message: SessionMessage;
  readonly target: SessionMessageDeliveryTarget;
  readonly prompt: string;
}

export interface SessionMessageAccepted {
  readonly kind: "accepted";
  readonly message: SessionMessageRecord;
  readonly workflow_id: string;
}

export interface SessionMessageConflict {
  readonly kind: "idempotency_conflict";
  readonly detail: string;
}

export type SessionMessageEnqueueResult = SessionMessageAccepted | SessionMessageConflict;

export type DeliveryKeyValidation =
  | { readonly kind: "valid"; readonly delivery_key: DeliveryKey }
  | { readonly kind: "invalid"; readonly detail: string };

export const validateDeliveryKey = (value: string): DeliveryKeyValidation =>
  /^[A-Za-z0-9._:-]{1,128}$/.test(value)
    ? { kind: "valid", delivery_key: value as DeliveryKey }
    : { kind: "invalid", detail: "Idempotency-Key must be 1-128 letters, numbers, dots, underscores, colons, or hyphens" };

export const renderCollaborationPingPrompt = (thread: CollaborationThreadWithMessages): string => {
  const anchor = thread.anchor ? ` at ${thread.anchor}` : "";
  const transcript = thread.messages.map((message) => `${message.author}: ${message.body}`).join("\n\n");
  return `An operator requested your response to collaboration thread ${thread.id}${anchor}. Review the discussion and respond by posting a message to the same thread.\n\n${transcript}`;
};

export interface MessageParty {
  readonly kind: "core" | "agent" | "service" | "operator";
  readonly id: string | null;
}

export interface SessionMessageDeliveredResult { readonly kind: "delivered" }
export interface SessionMessageFailedResult { readonly kind: "failed"; readonly detail: string }
export type SessionMessageDeliveryResult = SessionMessageDeliveredResult | SessionMessageFailedResult;
export type SessionMessageDeliveryStatus = "pending" | SessionMessageDeliveryResult["kind"];

/** Delivery workflows own retries while pending; either recorded result is terminal for the durable key. */
export const isTerminalSessionMessageDelivery = (status: SessionMessageDeliveryStatus): boolean => status !== "pending";

interface SessionMessageRecordFields extends SessionMessage {
  readonly sender_kind: MessageParty["kind"];
  readonly sender_id: string | null;
  readonly recipient_kind: MessageParty["kind"];
  readonly recipient_id: string | null;
}

/** Mirrors oakridge.session_message; artifact_thread_id is optional context. */
export type SessionMessageRecord =
  | (SessionMessageRecordFields & { readonly delivery_status: "pending"; readonly delivery_result: null; readonly delivered_at: null })
  | (SessionMessageRecordFields & { readonly delivery_status: "delivered"; readonly delivery_result: SessionMessageDeliveredResult; readonly delivered_at: string })
  | (SessionMessageRecordFields & { readonly delivery_status: "failed"; readonly delivery_result: SessionMessageFailedResult; readonly delivered_at: null });

export type PutSessionMessageResult =
  | { readonly kind: "created"; readonly message: SessionMessageRecord }
  | { readonly kind: "existing"; readonly message: SessionMessageRecord }
  | SessionMessageConflict;

export interface SessionMessageRepository {
  put_pending(message: SessionMessage): Promise<PutSessionMessageResult>;
  find_by_delivery_key(run_id: WorkflowRunId, delivery_key: DeliveryKey): Promise<SessionMessageRecord | null>;
  record_delivery_result(message_id: SessionMessageId, result: SessionMessageDeliveryResult, recorded_at: string): Promise<SessionMessageRecord>;
  list_for_run(run_id: WorkflowRunId, cohort_id?: CohortId): Promise<readonly SessionMessageRecord[]>;
}

export const renderSessionMessagePrompt = (body: JsonValue): string =>
  typeof body === "string" ? body : JSON.stringify(body);
