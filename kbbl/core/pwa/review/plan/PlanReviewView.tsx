import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ensureOk } from "../../lib/http";
import type { Theme } from "../../types";
import { useArtifactStream } from "../shared/useArtifactStream";
import { useViewport } from "../shared/useViewport";
import { DagEditor } from "./DagEditor";
import { CohortPanel } from "./CohortPanel";
import { Sheet } from "../shared/Sheet";
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
  const queryClient = useQueryClient();

  const planQuery = useQuery({
    queryKey: ["plans", { id }],
    queryFn: async (): Promise<Plan> => {
      const res = await fetch(`/plans/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(`plans: ${res.status}`);
      return (await res.json()) as Plan;
    },
  });
  const cohortsQuery = useQuery({
    queryKey: ["cohorts", { planId: id }],
    queryFn: async (): Promise<Cohort[]> => {
      const res = await fetch(`/cohorts?plan_id=${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(`cohorts: ${res.status}`);
      return (await res.json()) as Cohort[];
    },
  });
  const depsQuery = useQuery({
    queryKey: ["plans", { id }, "cohort-dependencies"],
    queryFn: async (): Promise<CohortDependency[]> => {
      const res = await fetch(
        `/plans/${encodeURIComponent(id)}/cohort-dependencies`,
      );
      if (!res.ok) throw new Error(`deps: ${res.status}`);
      return (await res.json()) as CohortDependency[];
    },
  });

  const [mode, setMode] = useState<ReviewMode>("review");
  const [selectedCohortId, setSelectedCohortId] = useState<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);

  const messagesQuery = useQuery({
    queryKey: ["threads", selectedThreadId, "messages"],
    enabled: !!selectedThreadId,
    queryFn: async (): Promise<Message[]> => {
      const res = await fetch(
        `/threads/${encodeURIComponent(selectedThreadId!)}/messages`,
      );
      if (!res.ok) return [];
      return (await res.json()) as Message[];
    },
  });

  // ReviewShell expects a Map<threadId, Message[]>; only the selected thread
  // is loaded at any time, so it's a single-entry Map.
  const threadMessages = useMemo(() => {
    const m = new Map<string, Message[]>();
    if (selectedThreadId && messagesQuery.data) {
      m.set(selectedThreadId, messagesQuery.data);
    }
    return m;
  }, [selectedThreadId, messagesQuery.data]);

  const { edits, threads, frozen } = useArtifactStream("plan", id);
  const { width } = useViewport();
  const isWide = width >= 1024;

  const createThreadMutation = useMutation({
    mutationFn: async (vars: { anchor: string | null }): Promise<{ id: string }> => {
      const res = await fetch("/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target_type: "plan",
          target_id: id,
          anchor: vars.anchor,
        }),
      });
      if (!res.ok) throw new Error(`thread create: ${res.status}`);
      return (await res.json()) as { id: string };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["threads", { target_type: "plan", target_id: id }],
      });
    },
  });

  const sendMessageMutation = useMutation({
    mutationFn: async (vars: { threadId: string; body: string }) => {
      const res = await fetch(`/threads/${encodeURIComponent(vars.threadId)}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: vars.body, author: "operator" }),
      });
      await ensureOk(res, "send thread message");
    },
    onSuccess: (_, vars) => {
      void queryClient.invalidateQueries({
        queryKey: ["threads", vars.threadId, "messages"],
      });
    },
  });

  const pingMutation = useMutation({
    mutationFn: async (threadId: string) => {
      const res = await fetch(`/threads/${encodeURIComponent(threadId)}/ping`, {
        method: "POST",
      });
      await ensureOk(res, "ping thread");
    },
  });

  const resolveMutation = useMutation({
    mutationFn: async (threadId: string) => {
      const res = await fetch(`/threads/${encodeURIComponent(threadId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "resolved" }),
      });
      await ensureOk(res, "resolve thread");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["threads", { target_type: "plan", target_id: id }],
      });
    },
  });

  const addEdgeMutation = useMutation({
    mutationFn: async (vars: {
      from_cohort_id: string;
      to_cohort_id: string;
    }) => {
      const res = await fetch("/cohort-dependencies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(vars),
      });
      if (!res.ok) throw new Error(`add edge: ${res.status}`);
      return (await res.json()) as CohortDependency;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["plans", { id }, "cohort-dependencies"],
      });
    },
  });

  const deleteEdgeMutation = useMutation({
    mutationFn: async (depId: string) => {
      const res = await fetch(
        `/cohort-dependencies/${encodeURIComponent(depId)}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error(`delete edge: ${res.status}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["plans", { id }, "cohort-dependencies"],
      });
    },
  });

  const updatePositionMutation = useMutation({
    mutationFn: async (vars: { cohortId: string; position: number }) => {
      const res = await fetch(
        `/cohorts/${encodeURIComponent(vars.cohortId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ position: vars.position }),
        },
      );
      if (!res.ok) throw new Error(`update position: ${res.status}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["cohorts", { planId: id }],
      });
    },
  });

  const statusMutation = useMutation({
    mutationFn: async (vars: { status: "approved" | "rejected"; reason?: string }) => {
      const res = await fetch(`/plans/${encodeURIComponent(id)}/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          vars.status === "rejected"
            ? { status: "rejected", reason: vars.reason }
            : { status: "approved" },
        ),
      });
      if (!res.ok) throw new Error(`status: ${res.status}`);
      return (await res.json()) as Plan;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["plans", { id }] });
      void queryClient.invalidateQueries({
        queryKey: ["plans", "pending_approval"],
      });
    },
  });

  const handleSelectThread = useCallback((threadId: string) => {
    setSelectedThreadId(threadId);
  }, []);

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
        const t = await createThreadMutation.mutateAsync({ anchor }).catch(() => null);
        if (t) setSelectedThreadId(t.id);
      })();
    },
    [threads, handleSelectThread, createThreadMutation, frozen],
  );

  const handleNewThread = useCallback(() => {
    if (frozen) return;
    void (async () => {
      const t = await createThreadMutation.mutateAsync({ anchor: null }).catch(() => null);
      if (t) setSelectedThreadId(t.id);
    })();
  }, [createThreadMutation, frozen]);

  const handleSendMessage = useCallback(
    (threadId: string, body: string) => {
      void sendMessageMutation.mutateAsync({ threadId, body }).catch(() => {});
    },
    [sendMessageMutation],
  );

  const handlePing = useCallback(
    (threadId: string) => {
      pingMutation.mutate(threadId);
    },
    [pingMutation],
  );

  const handleResolve = useCallback(
    (threadId: string) => {
      void (async () => {
        const resolved = await resolveMutation.mutateAsync(threadId).catch(() => false);
        if (resolved !== false && selectedThreadId === threadId) setSelectedThreadId(null);
      })();
    },
    [resolveMutation, selectedThreadId],
  );

  const handleAddEdge = useCallback(
    async (from_cohort_id: string, to_cohort_id: string) => {
      await addEdgeMutation.mutateAsync({ from_cohort_id, to_cohort_id }).catch(() => {});
    },
    [addEdgeMutation],
  );

  const handleDeleteEdge = useCallback(
    async (depId: string) => {
      await deleteEdgeMutation.mutateAsync(depId).catch(() => {});
    },
    [deleteEdgeMutation],
  );

  const handleUpdatePosition = useCallback(
    async (cohortId: string, position: number) => {
      await updatePositionMutation.mutateAsync({ cohortId, position }).catch(() => {});
    },
    [updatePositionMutation],
  );

  const handleApprove = useCallback(async () => {
    await statusMutation.mutateAsync({ status: "approved" }).catch(() => {});
  }, [statusMutation]);

  const handleReject = useCallback(
    async (reason: string) => {
      await statusMutation.mutateAsync({ status: "rejected", reason }).catch(() => {});
    },
    [statusMutation],
  );

  const plan = planQuery.data;
  const cohorts = cohortsQuery.data ?? [];
  const deps = depsQuery.data ?? [];
  const loading = planQuery.isPending || cohortsQuery.isPending || depsQuery.isPending;
  const error =
    planQuery.error instanceof Error
      ? planQuery.error.message
      : cohortsQuery.error instanceof Error
        ? cohortsQuery.error.message
        : depsQuery.error instanceof Error
          ? depsQuery.error.message
          : null;

  const selectedThread = threads.find((t) => t.id === selectedThreadId) ?? null;
  const selectedCohort = cohorts.find((c) => c.id === selectedCohortId) ?? null;

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

  const cohortPanelContent = selectedCohort && !selectedThread ? (
    <CohortPanel
      cohort={selectedCohort}
      edits={edits}
      threads={threads}
      mode={mode}
      frozen={frozen}
      onOpenThread={handleOpenThread}
    />
  ) : null;

  return (
    <ReviewShell
      onBack={onBack}
      artifactTypeLabel="Plan review"
      statusLabel={plan.status}
      frozen={frozen}
      actionPending={statusMutation.isPending}
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

      {/* Cohort detail: pinned aside at ≥1024px, bottom Sheet below 1024px */}
      {isWide ? (
        cohortPanelContent && (
          <aside className="plan-review__cohort-pane">
            <button
              type="button"
              className="review-shell__tap-target plan-review__cohort-pane-close"
              onClick={() => setSelectedCohortId(null)}
              aria-label="Close cohort details"
            >
              ×
            </button>
            {cohortPanelContent}
          </aside>
        )
      ) : (
        <Sheet
          open={!!selectedCohort && !selectedThread}
          side="bottom"
          onClose={() => setSelectedCohortId(null)}
          ariaLabel="Cohort details"
        >
          {cohortPanelContent}
        </Sheet>
      )}
    </ReviewShell>
  );
}
