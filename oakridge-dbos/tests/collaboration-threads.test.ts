import { expect, test } from "bun:test";
import { revisionCollaborationTarget } from "../src/storage/collaboration";
import { addCollaborationMessage, addReviewItem, readCollaborationThreads } from "../src/storage/collaboration";
import { selectCollaborationThreadView } from "../src/projections/collaboration-view";
import type { SqlExecutor, TransactionalSqlExecutor } from "../src/storage/sql-executor";

test("operator edit addresses the nearest preceding agent revision", () => {
  expect(revisionCollaborationTarget("operator-edit", [
    { id: "operator-edit", predecessor_id: "agent-2", execution_id: null },
    { id: "agent-2", predecessor_id: "agent-1", execution_id: "execution-2" },
    { id: "agent-1", predecessor_id: null, execution_id: "execution-1" },
  ])).toEqual({ revision_id: "agent-2", execution_id: "execution-2" });
});

test("superseded revision refuses new messages and review items", async () => {
  const tx: SqlExecutor = { async query<Row extends object>(sql: string): Promise<readonly Row[]> {
    if (sql.includes("collaboration_message WHERE id") || sql.includes("review_item WHERE id")) return [];
    if (sql.includes("collaboration_thread WHERE id")) return [{ id: "thread",run_id: "run",scope_id: "scope",
      artifact_revision_id: "old", context: { title: "Review", anchor: null }, created_at: new Date().toISOString() }] as unknown as Row[];
    if (sql.includes("FROM authority.artifact_revision r JOIN authority.output_slot")) return [{ run_id: "run",scope_id: "scope",
      output_key: "output",collection_key: "",current_revision_id: "new" }] as unknown as Row[];
    throw new Error(`unexpected SQL: ${sql}`);
  } };
  const db: TransactionalSqlExecutor = { ...tx, transaction: async (operation) => operation(tx) };
  expect(await addCollaborationMessage(db,{ id: "message",run_id: "run",scope_id: "scope",thread_id: "thread",
    body: { text: "new text", author: "operator" } })).toEqual({ kind: "superseded" });
  expect(await addReviewItem(db,{ id: "item",run_id: "run",scope_id: "scope",thread_id: "thread",
    body: { title: "Issue",detail: "Fix",status: "open" } })).toEqual({ kind: "superseded" });
});

test("thread view exposes write capability and failed delivery reason", () => {
  const view = selectCollaborationThreadView({ id: "thread",run_id: "run",scope_id: "scope",artifact_revision_id: "old",
    current_revision_id: "new",context: { title: "Review",anchor: null },created_at: new Date().toISOString() },[],[],[
    { id: "delivery",run_id: "run",scope_id: "scope",message_id: "message",created_at: new Date().toISOString(),
      payload: { status: "failed",session_id: null,reason: "session ensure failed: worktree unavailable",request_key: "key" } },
  ]);
  expect(view.capabilities.can_write).toBe(false);
  expect(view.last_delivery_failure_reason).toBe("session ensure failed: worktree unavailable");
});

test("current revision read includes older threads as read-only history", async () => {
  const db: SqlExecutor = { async query<Row extends object>(sql: string, args: readonly unknown[]): Promise<readonly Row[]> {
    if (sql.includes("WITH RECURSIVE chain")) {
      expect(args).toEqual(["run", "scope", "current"]);
      return [{ id: "old-thread", run_id: "run", scope_id: "scope", artifact_revision_id: "old",
        context: { title: "Prior review", anchor: null }, created_at: "2026-01-01T00:00:00Z", current_revision_id: "current" },
      { id: "current-thread", run_id: "run", scope_id: "scope", artifact_revision_id: "current",
        context: { title: "Current review", anchor: null }, created_at: "2026-01-02T00:00:00Z", current_revision_id: "current" }] as unknown as Row[];
    }
    if (sql.includes("collaboration_message") || sql.includes("review_item") || sql.includes("collaboration_delivery")) return [];
    throw new Error(`unexpected SQL: ${sql}`);
  } };
  const threads = await readCollaborationThreads(db, "run", "scope", "current");
  expect(threads.map((thread) => [thread.id, thread.capabilities.can_write])).toEqual([
    ["old-thread", false], ["current-thread", true],
  ]);
});
