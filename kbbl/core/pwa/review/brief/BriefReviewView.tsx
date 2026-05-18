import { useState, useEffect, useCallback } from "react";
import type { Theme } from "../../types";
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

function RunBuildButton({ briefId, cohortId }: { briefId: string; cohortId: string }) {
  const [pending, setPending] = useState(false);
  const [sessionRef, setSessionRef] = useState<string | null>(null);
  // "checking": looking up the cohort's current_session_ref so we don't
  // race the auto-dispatch that brief.approved triggers in dispatch-hooks.
  // Only treat the ref as a live build when current_session_stage === "build"
  // — otherwise a stale planner2 ref on the same column would hide the
  // manual recovery button. The residual ~ms window between approve-emit
  // and the dispatcher's UPDATE is acknowledged in docs/known_issues.md.
  const [checking, setChecking] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setChecking(true);
    fetch(`/cohorts/${encodeURIComponent(cohortId)}`)
      .then((r) =>
        r.ok
          ? (r.json() as Promise<{
              current_session_ref: string | null;
              current_session_stage: string | null;
            }>)
          : null,
      )
      .then((cohort) => {
        if (cancelled) return;
        if (cohort?.current_session_ref && cohort.current_session_stage === "build") {
          setSessionRef(cohort.current_session_ref);
        }
      })
      .catch(() => {
        // Non-fatal — fall through to manual button; the route guard still
        // defends against most double-dispatch.
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => { cancelled = true; };
  }, [cohortId]);

  const handleRun = async () => {
    setPending(true);
    setErr(null);
    try {
      const res = await fetch(`/briefs/${encodeURIComponent(briefId)}/build`, { method: "POST" });
      if (res.ok) {
        const data = (await res.json()) as { session_ref: string };
        setSessionRef(data.session_ref);
      } else {
        const body = (await res.json()) as { error?: string };
        setErr(body.error ?? `${res.status}`);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "request failed");
    } finally {
      setPending(false);
    }
  };

  if (sessionRef) {
    return (
      <span style={{ fontSize: 12, opacity: 0.8 }}>
        Build running — session {sessionRef.slice(0, 8)}
      </span>
    );
  }

  if (checking) {
    return (
      <span style={{ fontSize: 12, opacity: 0.6 }}>
        Checking build status…
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        disabled={pending}
        onClick={() => { void handleRun(); }}
        style={{
          background: "var(--accent-blue)",
          color: "#fff",
          border: "none",
          padding: "4px 12px",
          borderRadius: 4,
          cursor: pending ? "default" : "pointer",
          opacity: pending ? 0.5 : 1,
        }}
      >
        {pending ? "…" : "Run build"}
      </button>
      {err && (
        <span style={{ fontSize: 12, color: "var(--danger-fg)", marginLeft: 6 }}>
          {err}
        </span>
      )}
    </>
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
      if (frozen) return;
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
    if (frozen) return;
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
        <div style={{ color: "var(--danger-fg)" }}>
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
          borderBottom: "1px solid var(--border-subtle)",
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
                background: "var(--success-fg)",
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
                background: "var(--danger-fg)",
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
        {brief.status === "approved" && <RunBuildButton briefId={brief.id} cohortId={brief.cohort_id} />}
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
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-subtle)",
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
              borderLeft: "1px solid var(--border-subtle)",
              overflow: "auto",
            }}
          >
            <div
              style={{
                padding: "8px 12px",
                borderBottom: "1px solid var(--border-subtle)",
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
