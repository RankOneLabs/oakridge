export type ArtifactTarget = { type: "plan" | "build_brief"; id: string };

export interface AtomEditEvent {
  type: "atom_edit";
  edit_id: string;
  anchor: string;
  new_value: string;
  prev_value: string | null;
  edited_by: string;
  thread_id: string | null;
  created_at: string;
}

export interface ThreadEvent {
  type: "thread";
  thread_id: string;
  anchor: string | null;
  event: "created" | "message_added" | "status_changed" | "agent_response_completed" | "agent_response_failed";
  data: Record<string, unknown>;
}

export interface StatusEvent {
  type: "status";
  status: "pending_approval" | "approved" | "rejected" | "superseded";
}

export type ArtifactStreamEvent = AtomEditEvent | ThreadEvent | StatusEvent;

export interface AtomEditRecord {
  id: string;
  target_type: string;
  target_id: string;
  anchor: string;
  prev_value: string | null;
  new_value: string;
  edited_by: string;
  thread_id: string | null;
  created_at: string;
}

export interface ThreadMessage {
  id: string;
  thread_id: string;
  author: string;
  body: string;
  related_edit_id: string | null;
  created_at: string;
}

export interface CommentThread {
  id: string;
  target_type: string;
  target_id: string;
  anchor: string | null;
  status: "open" | "resolved";
  agent_responding: number;
  resolved_at: string | null;
  created_at: string;
  messages: ThreadMessage[];
}
