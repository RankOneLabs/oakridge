import type { ExternalExecutionReference } from "./execution";
import type { ArtifactId, Brand, ExecutionId } from "./primitives";

export type ThreadId = Brand<string, "ThreadId">;
export type MessageId = Brand<string, "MessageId">;
export type CollaborationPingRequestId = Brand<string, "CollaborationPingRequestId">;
export type ReviewItemId = Brand<string, "ReviewItemId">;
export type ThreadStatus = "open" | "resolved";
export type ReviewItemStatus = "open" | "resolved" | "waived";
export interface CollaborationThread { readonly id: ThreadId; readonly artifact_id: ArtifactId; readonly revision_id: ArtifactId; readonly anchor: string | null; readonly status: ThreadStatus; readonly created_at: string }
export interface CollaborationMessage { readonly id: MessageId; readonly thread_id: ThreadId; readonly body: string; readonly author: string; readonly created_at: string }
export interface CollaborationThreadWithMessages extends CollaborationThread { readonly messages: readonly CollaborationMessage[] }
export interface ReviewItem { readonly id: ReviewItemId; readonly artifact_id: ArtifactId; readonly revision_id: ArtifactId; readonly anchor: string; readonly claim: string; readonly reality: string; readonly status: ReviewItemStatus; readonly resolution: string | null; readonly created_at: string }
export interface ReviewItemCandidate { readonly anchor: string; readonly claim: string; readonly reality: string }

export interface CollaborationPingRequest {
  readonly thread_id: ThreadId;
  readonly request_id: CollaborationPingRequestId;
  readonly execution_id: ExecutionId;
  readonly executor_type: string;
  readonly external_reference: ExternalExecutionReference;
  readonly prompt: string;
}

export interface CollaborationPingAccepted {
  readonly kind: "accepted";
  readonly request_id: CollaborationPingRequestId;
  readonly workflow_id: string;
}

export type CollaborationPingState =
  | { readonly kind: "delivering"; readonly thread_id: ThreadId; readonly request_id: CollaborationPingRequestId }
  | { readonly kind: "delivered"; readonly thread_id: ThreadId; readonly request_id: CollaborationPingRequestId };

export type CollaborationPingRequestIdValidation =
  | { readonly kind: "valid"; readonly request_id: CollaborationPingRequestId }
  | { readonly kind: "invalid"; readonly detail: string };

export const validateCollaborationPingRequestId = (value: string): CollaborationPingRequestIdValidation =>
  /^[A-Za-z0-9._:-]{1,128}$/.test(value)
    ? { kind: "valid", request_id: value as CollaborationPingRequestId }
    : { kind: "invalid", detail: "Idempotency-Key must be 1-128 letters, numbers, dots, underscores, colons, or hyphens" };

export const renderCollaborationPingPrompt = (thread: CollaborationThreadWithMessages): string => {
  const anchor = thread.anchor ? ` at ${thread.anchor}` : "";
  const transcript = thread.messages.map((message) => `${message.author}: ${message.body}`).join("\n\n");
  return `An operator requested your response to collaboration thread ${thread.id}${anchor}. Review the discussion and respond by posting a message to the same thread.\n\n${transcript}`;
};
