import { useState } from "react";
import type { CommentThread } from "./types";

interface Props {
  thread: CommentThread;
  onPostMessage: (threadId: string, body: string) => Promise<void>;
  onPing: (threadId: string) => Promise<void>;
  onResolve: (threadId: string) => Promise<void>;
}

export function ThreadView({ thread, onPostMessage, onPing, onResolve }: Props) {
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [pinging, setPinging] = useState(false);
  const [resolving, setResolving] = useState(false);

  const agentResponding = thread.agent_responding === 1;

  async function handlePost() {
    if (!draft.trim()) return;
    setPosting(true);
    try {
      await onPostMessage(thread.id, draft.trim());
      setDraft("");
    } catch {
      // network errors surfaced by parent callback
    } finally {
      setPosting(false);
    }
  }

  async function handlePing() {
    setPinging(true);
    try { await onPing(thread.id); } catch { /* parent handles */ } finally { setPinging(false); }
  }

  async function handleResolve() {
    setResolving(true);
    try { await onResolve(thread.id); } catch { /* parent handles */ } finally { setResolving(false); }
  }

  return (
    <div className="thread-view">
      <div className="thread-view-header">
        <span className="thread-anchor">{thread.anchor ?? "plan"}</span>
        <span className={`thread-status thread-status--${thread.status}`}>{thread.status}</span>
      </div>
      <div className="thread-messages">
        {thread.messages.map((msg) => (
          <div key={msg.id} className="thread-message">
            <span className="thread-message-author">{msg.author}</span>
            <span className="thread-message-time">{new Date(msg.created_at).toLocaleTimeString()}</span>
            <div className="thread-message-body">{msg.body}</div>
          </div>
        ))}
      </div>
      {agentResponding && (
        <div className="thread-agent-thinking">agent thinking…</div>
      )}
      <div className="thread-compose">
        <textarea
          className="thread-compose-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Write a message…"
          rows={3}
        />
        <div className="thread-compose-actions">
          <button
            type="button"
            className="thread-send"
            disabled={posting || !draft.trim()}
            onClick={() => void handlePost()}
          >
            send
          </button>
          <button
            type="button"
            className="thread-ping"
            disabled={agentResponding || pinging}
            title={agentResponding ? "agent thinking…" : "ping agent"}
            onClick={() => void handlePing()}
          >
            {agentResponding ? "agent thinking…" : "ping agent"}
          </button>
          {thread.status === "open" && (
            <button
              type="button"
              className="thread-resolve"
              disabled={resolving}
              onClick={() => void handleResolve()}
            >
              resolve
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function isPingDisabled(thread: CommentThread): boolean {
  return thread.agent_responding === 1;
}
