import { useState, useEffect, useCallback } from "react";
import type { Theme } from "../../types";
import { useArtifactStream } from "../shared/useArtifactStream";
import { useDirectEdit } from "../shared/useDirectEdit";
import { StructuredDocEditor } from "./StructuredDocEditor";
import { ReviewShell } from "../shared/ReviewShell";
import { RunBuildButton } from "../shared/RunBuildButton";
import type { ReviewMode, Message } from "../shared/types";
import type { Brief } from "./types";

interface BriefReviewViewProps {
  id: string;
  theme: Theme;
  onToggleTheme: () => void;
  onBack: () => void;
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

  const handleReject = useCallback(
    async (reason: string) => {
      setActionPending(true);
      try {
        const res = await fetch(`/briefs/${encodeURIComponent(id)}/status`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "rejected", reason }),
        });
        if (res.ok) {
          const b = (await res.json()) as Brief;
          setBrief(b);
        }
      } finally {
        setActionPending(false);
      }
    },
    [id],
  );

  if (loading) {
    return (
      <div className="review-load-shell">
        <button type="button" onClick={onBack}>Back</button>
        <div>Loading brief…</div>
      </div>
    );
  }

  if (error || !brief) {
    return (
      <div className="review-load-shell">
        <button type="button" onClick={onBack}>Back</button>
        <div className="review-error-message">{error ?? "Brief not found"}</div>
      </div>
    );
  }

  const isPendingApproval = brief.status === "pending_approval";

  return (
    <ReviewShell
      onBack={onBack}
      artifactTypeLabel="Brief review"
      statusLabel={brief.status}
      frozen={frozen}
      actionPending={actionPending}
      isPendingApproval={isPendingApproval}
      onToggleTheme={onToggleTheme}
      mode={mode}
      onModeChange={setMode}
      onApprove={handleApprove}
      onReject={handleReject}
      rejectSubjectLabel="brief"
      approveSubjectLabel="brief"
      artifactId={id}
      threads={threads}
      selectedThreadId={selectedThreadId}
      threadMessages={threadMessages}
      onSelectThread={handleSelectThread}
      onCloseThread={() => setSelectedThreadId(null)}
      onNewThread={handleNewThread}
      onSendMessage={handleSendMessage}
      onPing={handlePing}
      onResolve={handleResolve}
    >
      <div className="brief-canvas-scroll">
        {brief.status === "approved" && (
          <RunBuildButton briefId={brief.id} cohortId={brief.cohort_id} />
        )}
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
          <div className="brief-debrief">
            <div className="brief-debrief__label">Debrief</div>
            <div className="brief-debrief__body">{brief.debrief}</div>
          </div>
        )}
      </div>
    </ReviewShell>
  );
}
