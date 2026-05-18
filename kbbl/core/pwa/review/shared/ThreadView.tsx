import { useState } from "react";
import type { Thread, Message } from "./types";

interface ThreadViewProps {
  thread: Thread;
  messages: Message[];
  onSendMessage: (body: string) => void;
  onPing: () => void;
  onResolve: () => void;
  frozen: boolean;
}

export function ThreadView({
  thread,
  messages,
  onSendMessage,
  onPing,
  onResolve,
  frozen,
}: ThreadViewProps) {
  const [reply, setReply] = useState("");

  function handleSend() {
    const trimmed = reply.trim();
    if (!trimmed) return;
    onSendMessage(trimmed);
    setReply("");
  }

  const isOpen = thread.status === "open";

  return (
    <div className="thread-view">
      <div className="thread-view__header">
        <span className="thread-view__title">
          {thread.anchor ? `@${thread.anchor}` : "General thread"}
        </span>
        <div className="thread-view__actions">
          {isOpen && !frozen && (
            <>
              <button type="button" onClick={onPing} className="thread-view__action-btn">
                Ping
              </button>
              <button type="button" onClick={onResolve} className="thread-view__action-btn">
                Resolve
              </button>
            </>
          )}
          {!isOpen && (
            <span className="thread-view__resolved-label">Resolved</span>
          )}
        </div>
      </div>

      <div className="thread-view__messages">
        {messages.map((m) => (
          <div key={m.id} className="thread-view__message">
            <div className="thread-view__message-meta">
              {m.author} · {m.created_at}
            </div>
            <div className="thread-view__message-body">{m.body}</div>
          </div>
        ))}
        {messages.length === 0 && (
          <div className="thread-view__empty">No messages yet.</div>
        )}
      </div>

      {isOpen && !frozen && (
        <div className="thread-view__compose">
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Reply…"
            className="thread-view__textarea"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSend();
            }}
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={!reply.trim()}
            className="thread-view__send-btn"
          >
            Send
          </button>
        </div>
      )}
    </div>
  );
}
