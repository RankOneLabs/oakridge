import type { ArtifactId, Brand } from "./primitives";

export type ThreadId = Brand<string, "ThreadId">;
export type MessageId = Brand<string, "MessageId">;
export type ReviewItemId = Brand<string, "ReviewItemId">;
export type ThreadStatus = "open" | "resolved";
export type ReviewItemStatus = "open" | "resolved" | "waived";
export interface CollaborationThread { readonly id: ThreadId; readonly artifact_id: ArtifactId; readonly revision_id: ArtifactId; readonly anchor: string | null; readonly status: ThreadStatus; readonly created_at: string }
export interface CollaborationMessage { readonly id: MessageId; readonly thread_id: ThreadId; readonly body: string; readonly author: string; readonly created_at: string }
export interface CollaborationThreadWithMessages extends CollaborationThread { readonly messages: readonly CollaborationMessage[] }
export interface ReviewItem { readonly id: ReviewItemId; readonly artifact_id: ArtifactId; readonly revision_id: ArtifactId; readonly anchor: string; readonly claim: string; readonly reality: string; readonly status: ReviewItemStatus; readonly resolution: string | null; readonly created_at: string }
export interface ReviewItemCandidate { readonly anchor: string; readonly claim: string; readonly reality: string }
