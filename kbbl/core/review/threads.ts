import type { Database } from "bun:sqlite";

export interface CommentThread {
  id: string;
  target_type: string;
  target_id: string;
  anchor: string | null;
  status: "open" | "resolved";
  author: string | null;
  created_at: string;
}

export interface ThreadMessage {
  id: string;
  thread_id: string;
  author: string;
  body: string;
  created_at: string;
}

export function insertThread(
  db: Database,
  thread: {
    id: string;
    target_type: string;
    target_id: string;
    anchor?: string | null;
    author?: string | null;
  },
): CommentThread {
  return db
    .prepare<CommentThread, [string, string, string, string | null, string | null]>(
      "INSERT INTO comment_threads (id, target_type, target_id, anchor, author) VALUES (?, ?, ?, ?, ?) RETURNING *",
    )
    .get(thread.id, thread.target_type, thread.target_id, thread.anchor ?? null, thread.author ?? null)!;
}

export function getThread(db: Database, id: string): CommentThread | null {
  return (
    db.prepare<CommentThread, [string]>("SELECT * FROM comment_threads WHERE id = ?").get(id) ?? null
  );
}

export function listThreadsByArtifact(
  db: Database,
  target_type: string,
  target_id: string,
): CommentThread[] {
  return db
    .prepare<CommentThread, [string, string]>(
      "SELECT * FROM comment_threads WHERE target_type = ? AND target_id = ? ORDER BY created_at ASC",
    )
    .all(target_type, target_id);
}

export function insertMessage(
  db: Database,
  message: { id: string; thread_id: string; author: string; body: string },
): ThreadMessage {
  return db
    .prepare<ThreadMessage, [string, string, string, string]>(
      "INSERT INTO thread_messages (id, thread_id, author, body) VALUES (?, ?, ?, ?) RETURNING *",
    )
    .get(message.id, message.thread_id, message.author, message.body)!;
}

export function listMessagesByThread(db: Database, thread_id: string): ThreadMessage[] {
  return db
    .prepare<ThreadMessage, [string]>(
      "SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY created_at ASC",
    )
    .all(thread_id);
}

export function updateThreadStatus(
  db: Database,
  id: string,
  status: "resolved",
): CommentThread | null {
  return (
    db
      .prepare<CommentThread, [string, string]>(
        "UPDATE comment_threads SET status = ? WHERE id = ? RETURNING *",
      )
      .get(status, id) ?? null
  );
}
