import { useState, useEffect, useCallback } from "react";
import type { Theme } from "../../App";
import { useArtifactStream } from "../shared/useArtifactStream";
import { DagEditor } from "./DagEditor";
import { CohortPanel } from "./CohortPanel";
import { ThreadSidebar } from "../shared/ThreadSidebar";
import { ThreadView } from "../shared/ThreadView";
import { ModeToggle } from "../shared/ModeToggle";
import { ApproveModal } from "./ApproveModal";
import { RejectModal } from "./RejectModal";
import type { ReviewMode, Message } from "../shared/types";
import type { Plan, Cohort, CohortDependency } from "./types";

interface PlanReviewViewProps {
  id: string;
  theme: Theme;
  onToggleTheme: () => void;
  onBack: () => void;
}

export function PlanReviewView({ id, onToggleTheme, onBack }: PlanReviewViewProps) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [cohorts, setCohorts] = useState<Cohort[]>([]);
  const [deps, setDeps] = useState<CohortDependency[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<ReviewMode>("review");
  const [selectedCohortId, setSelectedCohortId] = useState<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [threadMessages, setThreadMessages] = useState<Map<string, Message[]>>(
    () => new Map(),
  );

  const [showApprove, setShowApprove] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [actionPending, setActionPending] = useState(false);

  const { edits, threads, frozen } = useArtifactStream("plan", id);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      fetch(`/plans/${encodeURIComponent(id)}`).then((r) => {
        if (!r.ok) throw new Error(`plans: ${r.status}`);
        return r.json() as Promise<Plan>;
      }),
      fetch(`/cohorts?plan_id=${encodeURIComponent(id)}`).then((r) => {
        if (!r.ok) throw new Error(`cohorts: ${r.status}`);
        return r.json() as Promise<Cohort[]>;
      }),
      fetch(`/plans/${encodeURIComponent(id)}/cohort-dependencies`).then((r) => {
        if (!r.ok) throw new Error(`deps: ${r.status}`);
        return r.json() as Promise<CohortDependency[]>;
      }),
    ])
      .then(([p, c, d]) => {
        if (cancelled) return;
        setPlan(p);
        setCohorts(c);
        setDeps(d);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "load failed");
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [id]);

  const fetchMessages = useCallback(
    async (threadId: string) => {
      const res = await fetch(`/threads/${encodeURIComponent(threadId)}/messages`);
      if (!res.ok) return;
      const msgs = (await res.json()) as Message[];
      setThreadMessages((prev) => new Map(prev).set(threadId, msgs));
    },
    [],
  );

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
          body: JSON.stringify({ target_type: "plan", target_id: id, anchor }),
        });
        if (!res.ok) return;
        const t = await res.json() as { id: string };
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
        body: JSON.stringify({ target_type: "plan", target_id: id, anchor: null }),
      });
      if (!res.ok) return;
      const t = await res.json() as { id: string };
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

  const handleAddEdge = useCallback(
    async (from_cohort_id: string, to_cohort_id: string) => {
      const res = await fetch("/cohort-dependencies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from_cohort_id, to_cohort_id }),
      });
      if (!res.ok) return;
      const dep = (await res.json()) as CohortDependency;
      setDeps((prev) => [...prev, dep]);
    },
    [],
  );

  const handleDeleteEdge = useCallback(async (depId: string) => {
    const res = await fetch(`/cohort-dependencies/${encodeURIComponent(depId)}`, {
      method: "DELETE",
    });
    if (!res.ok) return;
    setDeps((prev) => prev.filter((d) => d.id !== depId));
  }, []);

  const handleUpdatePosition = useCallback(
    async (cohortId: string, position: number) => {
      const res = await fetch(`/cohorts/${encodeURIComponent(cohortId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ position }),
      });
      if (!res.ok) return;
      const updated = (await res.json()) as Cohort;
      setCohorts((prev) =>
        prev.map((c) => (c.id === updated.id ? updated : c)),
      );
    },
    [],
  );

  const handleApprove = useCallback(async () => {
    setActionPending(true);
    try {
      const res = await fetch(`/plans/${encodeURIComponent(id)}/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "approved" }),
      });
      if (res.ok) {
        const p = (await res.json()) as Plan;
        setPlan(p);
      }
    } finally {
      setActionPending(false);
      setShowApprove(false);
    }
  }, [id]);

  const handleReject = useCallback(
    async (reason: string) => {
      setActionPending(true);
      try {
        const res = await fetch(`/plans/${encodeURIComponent(id)}/status`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "rejected", reason }),
        });
        if (res.ok) {
          const p = (await res.json()) as Plan;
          setPlan(p);
        }
      } finally {
        setActionPending(false);
        setShowReject(false);
      }
    },
    [id],
  );

  const selectedThread = threads.find((t) => t.id === selectedThreadId) ?? null;
  const selectedCohort =
    cohorts.find((c) => c.id === selectedCohortId) ?? null;

  if (loading) {
    return (
      <div style={{ padding: 24 }}>
        <button type="button" onClick={onBack} style={{ marginBottom: 16 }}>
          Back
        </button>
        <div>Loading plan…</div>
      </div>
    );
  }

  if (error || !plan) {
    return (
      <div style={{ padding: 24 }}>
        <button type="button" onClick={onBack} style={{ marginBottom: 16 }}>
          Back
        </button>
        <div style={{ color: "var(--danger, #c55)" }}>
          {error ?? "Plan not found"}
        </div>
      </div>
    );
  }

  const isPendingApproval = plan.status === "pending_approval";

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
          Plan review — {plan.status}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={onToggleTheme} style={{ fontSize: 12 }}>
          Theme
        </button>
        <ModeToggle
          mode={mode}
          onChange={setMode}
          disabled={frozen}
        />
        {isPendingApproval && (
          <>
            <button
              type="button"
              onClick={() => setShowApprove(true)}
              style={{
                background: "var(--success, #2a7a2a)",
                color: "#fff",
                border: "none",
                padding: "4px 12px",
                borderRadius: 4,
                cursor: "pointer",
              }}
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() => setShowReject(true)}
              style={{
                background: "var(--danger, #7a2a2a)",
                color: "#fff",
                border: "none",
                padding: "4px 12px",
                borderRadius: 4,
                cursor: "pointer",
              }}
            >
              Reject
            </button>
          </>
        )}
      </header>

      {/* Main area */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* DAG canvas */}
        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
          <DagEditor
            cohorts={cohorts}
            deps={deps}
            threads={threads}
            mode={mode}
            frozen={frozen}
            selectedCohortId={selectedCohortId}
            onSelectCohort={setSelectedCohortId}
            onOpenThread={handleOpenThread}
            onAddEdge={handleAddEdge}
            onDeleteEdge={handleDeleteEdge}
            onUpdatePosition={handleUpdatePosition}
          />
        </div>

        {/* Right panel: cohort details or thread view */}
        {selectedCohort && !selectedThread && (
          <CohortPanel
            cohort={selectedCohort}
            edits={edits}
            threads={threads}
            mode={mode}
            frozen={frozen}
            onOpenThread={handleOpenThread}
          />
        )}
        {selectedThread && (
          <div style={{ minWidth: 280, borderLeft: "1px solid var(--border, #444)", overflow: "auto" }}>
            <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border, #444)", display: "flex", gap: 8 }}>
              <button type="button" style={{ fontSize: 12 }} onClick={() => setSelectedThreadId(null)}>
                Close
              </button>
            </div>
            <ThreadView
              thread={selectedThread}
              messages={threadMessages.get(selectedThread.id) ?? []}
              onSendMessage={(body) => handleSendMessage(selectedThread.id, body)}
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

      {showApprove && (
        <ApproveModal
          planId={id}
          onConfirm={handleApprove}
          onCancel={() => setShowApprove(false)}
          pending={actionPending}
        />
      )}
      {showReject && (
        <RejectModal
          planId={id}
          onConfirm={handleReject}
          onCancel={() => setShowReject(false)}
          pending={actionPending}
        />
      )}
    </div>
  );
}
