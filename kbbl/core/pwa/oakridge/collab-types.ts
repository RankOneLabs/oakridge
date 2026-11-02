// Review collaboration: threads, messages and review items.
export interface CollabMessage {
  id: string;
  thread_id: string;
  body: string;
  author: string;
  created_at: string;
}

export interface CollabThread {
  id: string;
  artifact_id: string;
  revision_id: string;
  anchor: string | null;
  status: "open" | "resolved";
  created_at: string;
  messages: CollabMessage[];
}

export interface ReviewItem {
  id: string;
  artifact_id: string;
  revision_id: string;
  anchor: string;
  claim: string;
  reality: string;
  status: "open" | "resolved" | "waived";
  resolution: string | null;
  created_at: string;
}

export interface PostThreadRequest {
  anchor?: string | null;
  body: string;
  author: string;
}

export interface PostMessageRequest {
  body: string;
  author: string;
}

export interface PostAtomEditRequest {
  anchor: string;
  prev_value: unknown;
  new_value: unknown;
  author: string;
}

export interface PostReviewItemRequest {
  anchor: string;
  claim: string;
  reality: string;
}

export interface PatchReviewItemRequest {
  status: "resolved" | "waived";
  resolution?: string;
}
