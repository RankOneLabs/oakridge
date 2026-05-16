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
    <div
      style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12 }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 13 }}>
          {thread.anchor ? `@${thread.anchor}` : "General thread"}
        </span>
        <div style={{ display: "flex", gap: 4 }}>
          {isOpen && !frozen && (
            <>
              <button type="button" onClick={onPing} style={{ fontSize: 12 }}>
                Ping
              </button>
              <button
                type="button"
                onClick={onResolve}
                style={{ fontSize: 12 }}
              >
                Resolve
              </button>
            </>
          )}
          {!isOpen && (
            <span style={{ fontSize: 12, opacity: 0.5 }}>Resolved</span>
          )}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {messages.map((m) => (
          <div
            key={m.id}
            style={{
              background: "var(--surface-raised, #2a2a2a)",
              borderRadius: 4,
              padding: "6px 10px",
            }}
          >
            <div style={{ fontSize: 11, opacity: 0.6 }}>
              {m.author} · {m.created_at}
            </div>
            <div style={{ fontSize: 13, marginTop: 2, whiteSpace: "pre-wrap" }}>
              {m.body}
            </div>
          </div>
        ))}
        {messages.length === 0 && (
          <div style={{ fontSize: 12, opacity: 0.5 }}>No messages yet.</div>
        )}
      </div>

      {isOpen && !frozen && (
        <div style={{ display: "flex", gap: 4 }}>
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Reply…"
            style={{ flex: 1, resize: "vertical", fontSize: 13, minHeight: 60 }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSend();
            }}
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={!reply.trim()}
            style={{ alignSelf: "flex-end" }}
          >
            Send
          </button>
        </div>
      )}
    </div>
  );
}
