import { useState, useEffect, useCallback } from "react";
import type { Theme } from "../../App";
import { useArtifactStream } from "../shared/useArtifactStream";
import { useDirectEdit } from "../shared/useDirectEdit";
import { StructuredDocEditor } from "./StructuredDocEditor";
import { ThreadSidebar } from "../shared/ThreadSidebar";
import { ThreadView } from "../shared/ThreadView";
import { ModeToggle } from "../shared/ModeToggle";
import type { ReviewMode, Message } from "../shared/types";
import type { Brief } from "./types";

interface BriefReviewViewProps {
  id: string;
  theme: Theme;
  onToggleTheme: () => void;
  onBack: () => void;
}

function RunBuildButton({ briefId }: { briefId: string }) {
  return (
    <button
      type="button"
      disabled
      title="Run build — wired in cohort 5"
      style={{
        background: "var(--accent, #4a8fcb)",
        color: "#fff",
        border: "none",
        padding: "4px 12px",
        borderRadius: 4,
        opacity: 0.5,
        cursor: "default",
      }}
      onClick={() => {
        // TODO: wired in cohort 5
        void briefId;
      }}
    >
      Run build
    </button>
  );
}

export function BriefReviewView({ id, onToggleTheme, onBack }: BriefReviewViewProps) {
  const [brief, setBrief] = useState<Brief | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<ReviewMode>("review");
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [threadMessages, setThreadMessages] = useState<Map<string, Message[]>>(
    () => new Map(),
  );
  const [actionPending, setActionPending] = useState(false);

  const { edits, threads, frozen } = useArtifactStream("build_brief", id);
  const { editAtom } = useDirectEdit("build_brief", id, "operator");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/briefs/${encodeURIComponent(id)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`briefs: ${r.status}`);
        return r.json() as Promise<Brief>;
      })
      .then((b) => {
        if (cancelled) return;
        setBrief(b);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "load failed");
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [id]);

  const fetchMessages = useCallback(async (threadId: string) => {
    const res = await fetch(`/threads/${encodeURIComponent(threadId)}/messages`);
    if (!res.ok) return;
    const msgs = (await res.json()) as Message[];
    setThreadMessages((prev) => new Map(prev).set(threadId, msgs));
  }, []);

  const handleSelectThread = useCallback(
    (threadId: string) => {
      setSelectedThreadId(threadId);
      void fetchMessages(threadId);
    },
    [fetchMessages],
  );

  const handleOpenThread = useCallback(
    (anchor: string) => {
      const existing = threads.find(
        (t) => t.anchor === anchor && t.status === "open",
      );
      if (existing) {
        handleSelectThread(existing.id);
        return;
      }
      void (async () => {
        const res = await fetch("/threads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ target_type: "build_brief", target_id: id, anchor }),
        });
        if (!res.ok) return;
        const t = (await res.json()) as { id: string };
        setSelectedThreadId(t.id);
      })();
    },
    [threads, id, handleSelectThread],
  );

  const handleNewThread = useCallback(() => {
    void (async () => {
      const res = await fetch("/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target_type: "build_brief", target_id: id, anchor: null }),
      });
      if (!res.ok) return;
      const t = (await res.json()) as { id: string };
      setSelectedThreadId(t.id);
    })();
  }, [id]);

  const handleSendMessage = useCallback(
    (threadId: string, body: string) => {
      void (async () => {
        await fetch(`/threads/${encodeURIComponent(threadId)}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body, author: "operator" }),
        });
        await fetchMessages(threadId);
      })();
    },
    [fetchMessages],
  );

  const handlePing = useCallback((threadId: string) => {
    void fetch(`/threads/${encodeURIComponent(threadId)}/ping`, {
      method: "POST",
    });
  }, []);

  const handleResolve = useCallback(
    (threadId: string) => {
      void (async () => {
        await fetch(`/threads/${encodeURIComponent(threadId)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "resolved" }),
        });
        if (selectedThreadId === threadId) setSelectedThreadId(null);
      })();
    },
    [selectedThreadId],
  );

  const handleEdit = useCallback(
    (anchor: string, prevValue: string | null, newValue: string) => {
      void editAtom(anchor, prevValue, newValue);
    },
    [editAtom],
  );

  const handleApprove = useCallback(async () => {
    setActionPending(true);
    try {
      const res = await fetch(`/briefs/${encodeURIComponent(id)}/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "approved" }),
      });
      if (res.ok) {
        const b = (await res.json()) as Brief;
        setBrief(b);
      }
    } finally {
      setActionPending(false);
    }
  }, [id]);

  const handleReject = useCallback(async () => {
    // TODO(cohort-5): replace with a RejectModal like PlanReviewView uses
    const reason = window.prompt("Reason for rejection:");
    if (!reason?.trim()) return;
    setActionPending(true);
    try {
      const res = await fetch(`/briefs/${encodeURIComponent(id)}/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "rejected", reason: reason.trim() }),
      });
      if (res.ok) {
        const b = (await res.json()) as Brief;
        setBrief(b);
      }
    } finally {
      setActionPending(false);
    }
  }, [id]);

  const selectedThread = threads.find((t) => t.id === selectedThreadId) ?? null;

  if (loading) {
    return (
      <div style={{ padding: 24 }}>
        <button type="button" onClick={onBack} style={{ marginBottom: 16 }}>
          Back
        </button>
        <div>Loading brief…</div>
      </div>
    );
  }

  if (error || !brief) {
    return (
      <div style={{ padding: 24 }}>
        <button type="button" onClick={onBack} style={{ marginBottom: 16 }}>
          Back
        </button>
        <div style={{ color: "var(--danger, #c55)" }}>
          {error ?? "Brief not found"}
        </div>
      </div>
    );
  }

  const isPendingApproval = brief.status === "pending_approval";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100dvh",
        overflow: "hidden",
      }}
    >
      {/* Top bar */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "8px 16px",
          borderBottom: "1px solid var(--border, #444)",
          flexShrink: 0,
        }}
      >
        <button type="button" onClick={onBack}>
          Back
        </button>
        <span style={{ fontWeight: 600, fontSize: 14 }}>
          Brief review — {brief.status}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={onToggleTheme} style={{ fontSize: 12 }}>
          Theme
        </button>
        <ModeToggle mode={mode} onChange={setMode} disabled={frozen} />
        {isPendingApproval && (
          <>
            <button
              type="button"
              onClick={handleApprove}
              disabled={actionPending}
              style={{
                background: "var(--success, #2a7a2a)",
                color: "#fff",
                border: "none",
                padding: "4px 12px",
                borderRadius: 4,
                cursor: actionPending ? "default" : "pointer",
              }}
            >
              {actionPending ? "…" : "Approve"}
            </button>
            <button
              type="button"
              onClick={handleReject}
              disabled={actionPending}
              style={{
                background: "var(--danger, #7a2a2a)",
                color: "#fff",
                border: "none",
                padding: "4px 12px",
                borderRadius: 4,
                cursor: actionPending ? "default" : "pointer",
              }}
            >
              {actionPending ? "…" : "Reject"}
            </button>
          </>
        )}
        {brief.status === "approved" && <RunBuildButton briefId={brief.id} />}
      </header>

      {/* Main area */}
      <div
        style={{
          display: "flex",
          flex: 1,
          overflow: "hidden",
        }}
      >
        {/* Structured doc */}
        <div style={{ flex: 1, overflow: "auto", padding: "0 16px 24px" }}>
          <StructuredDocEditor
            brief={brief}
            edits={edits}
            threads={threads}
            mode={mode}
            frozen={frozen}
            onEdit={handleEdit}
            onOpenThread={handleOpenThread}
          />

          {brief.debrief && (
            <div
              style={{
                marginTop: 24,
                padding: "12px 16px",
                borderRadius: 6,
                background: "var(--surface-raised, #1e1e1e)",
                border: "1px solid var(--border, #444)",
              }}
            >
              <div
                style={{
                  fontWeight: 600,
                  fontSize: 13,
                  opacity: 0.7,
                  marginBottom: 8,
                }}
              >
                Debrief
              </div>
              <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>
                {brief.debrief}
              </div>
            </div>
          )}
        </div>

        {/* Thread detail pane */}
        {selectedThread && (
          <div
            style={{
              minWidth: 280,
              borderLeft: "1px solid var(--border, #444)",
              overflow: "auto",
            }}
          >
            <div
              style={{
                padding: "8px 12px",
                borderBottom: "1px solid var(--border, #444)",
              }}
            >
              <button
                type="button"
                style={{ fontSize: 12 }}
                onClick={() => setSelectedThreadId(null)}
              >
                Close
              </button>
            </div>
            <ThreadView
              thread={selectedThread}
              messages={threadMessages.get(selectedThread.id) ?? []}
              onSendMessage={(body) =>
                handleSendMessage(selectedThread.id, body)
              }
              onPing={() => handlePing(selectedThread.id)}
              onResolve={() => handleResolve(selectedThread.id)}
              frozen={frozen}
            />
          </div>
        )}

        {/* Thread sidebar */}
        <ThreadSidebar
          threads={threads}
          selectedThreadId={selectedThreadId}
          onSelect={handleSelectThread}
          onNewThread={handleNewThread}
        />
      </div>
    </div>
  );
}
