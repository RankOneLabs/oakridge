import { useState, useEffect, useCallback } from "react";
import type { Theme } from "../../types";
import { useArtifactStream } from "../shared/useArtifactStream";
import { DagEditor } from "./DagEditor";
import { CohortPanel } from "./CohortPanel";
import { ReviewShell } from "../shared/ReviewShell";
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
      }
    },
    [id],
  );

  const selectedThread = threads.find((t) => t.id === selectedThreadId) ?? null;
  const selectedCohort =
    cohorts.find((c) => c.id === selectedCohortId) ?? null;

  if (loading) {
    return (
      <div className="review-load-shell">
        <button type="button" onClick={onBack}>Back</button>
        <div>Loading plan…</div>
      </div>
    );
  }

  if (error || !plan) {
    return (
      <div className="review-load-shell">
        <button type="button" onClick={onBack}>Back</button>
        <div className="review-error-message">{error ?? "Plan not found"}</div>
      </div>
    );
  }

  const isPendingApproval = plan.status === "pending_approval";

  return (
    <ReviewShell
      onBack={onBack}
      artifactTypeLabel="Plan review"
      statusLabel={plan.status}
      frozen={frozen}
      actionPending={actionPending}
      isPendingApproval={isPendingApproval}
      onToggleTheme={onToggleTheme}
      mode={mode}
      onModeChange={setMode}
      onApprove={handleApprove}
      onReject={handleReject}
      rejectSubjectLabel="plan"
      approveSubjectLabel="plan"
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
      {/* DAG canvas */}
      <div className="plan-canvas-slot">
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

      {/* Cohort details panel (shown when a cohort is selected but no thread is open) */}
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
    </ReviewShell>
  );
}
