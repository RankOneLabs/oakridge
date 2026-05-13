import { useState, useEffect, useCallback } from "react";
import { DagEditor, type CohortShape, type DependencyShape } from "./DagEditor";
import { CohortPanel, type CohortAtom } from "./CohortPanel";
import { CohortContextMenu, EdgeContextMenu } from "./CohortContextMenu";
import { SplitCohortModal, type ResultCohortSpec, type EdgeMigration } from "./SplitCohortModal";
import { MergeCohortModal } from "./MergeCohortModal";
import { ApproveModal } from "./ApproveModal";
import { RejectModal } from "./RejectModal";
import { ThreadSidebar } from "../shared/ThreadSidebar";
import { ThreadView } from "../shared/ThreadView";
import { RevisionHistoryPanel } from "../shared/RevisionHistoryPanel";
import { usePlanStream } from "./usePlanStream";
import { useDirectEdit } from "../shared/useDirectEdit";
import type { AtomEditRecord, CommentThread } from "../shared/types";

interface SafirPlan {
  id: string;
  parent_task_id: number;
  summary: string | null;
  status: string;
  rejection_reason: string | null;
  cohorts: CohortAtom[];
  dependencies: DependencyShape[];
}

interface Props {
  planId: string;
  onBack: () => void;
}

type Mode = "direct-edit" | "review";

interface ContextMenuState {
  type: "cohort" | "edge";
  x: number;
  y: number;
  cohortIndex?: number;
  edgeFrom?: number;
  edgeTo?: number;
}

export function PlanReviewView({ planId, onBack }: Props) {
  const [plan, setPlan] = useState<SafirPlan | null>(null);
  const [atomHistory, setAtomHistory] = useState<AtomEditRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [mode, setMode] = useState<Mode>("direct-edit");
  const [selectedCohortIndex, setSelectedCohortIndex] = useState<number | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<{ from: number; to: number } | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [multiSelectIndices, setMultiSelectIndices] = useState<number[]>([]);

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [splitModal, setSplitModal] = useState<number | null>(null);
  const [mergeModal, setMergeModal] = useState(false);
  const [approveModal, setApproveModal] = useState(false);
  const [rejectModal, setRejectModal] = useState(false);
  const [acting, setActing] = useState(false);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [historyCollapsed, setHistoryCollapsed] = useState(true);

  const stream = usePlanStream(planId);
  const directEdit = useDirectEdit({ type: "plan", id: planId });

  // Merge streamed atomMap into plan cohorts + deps display
  const cohorts: CohortShape[] = (plan?.cohorts ?? []).map((c) => ({
    cohort_index: c.cohort_index,
    title: stream.atomMap[`cohorts[${c.cohort_index}].title`] ?? c.title,
    priority: Number(stream.atomMap[`cohorts[${c.cohort_index}].priority`] ?? c.priority),
  }));

  const dependencies: DependencyShape[] = plan?.dependencies ?? [];

  const threadCounts: Record<string, number> = {};
  for (const t of stream.threads) {
    if (t.anchor) {
      threadCounts[t.anchor] = (threadCounts[t.anchor] ?? 0) + 1;
    }
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const [planRes, histRes] = await Promise.all([
          fetch(`/safir/plans/${encodeURIComponent(planId)}`),
          fetch(`/safir/atoms/plan/${encodeURIComponent(planId)}/history`),
        ]);
        if (cancelled) return;
        if (!planRes.ok) { setError(`failed to load plan (HTTP ${planRes.status})`); setLoading(false); return; }
        setPlan((await planRes.json()) as SafirPlan);
        if (histRes.ok) setAtomHistory((await histRes.json()) as AtomEditRecord[]);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [planId]);

  // Keep history fresh when SSE delivers atom_edit events
  useEffect(() => {
    if (stream.lastEvent?.type === "atom_edit") {
      void fetch(`/safir/atoms/plan/${encodeURIComponent(planId)}/history`)
        .then((r) => r.ok ? r.json() : null)
        .then((h) => { if (h) setAtomHistory(h as AtomEditRecord[]); });
    }
  }, [stream.lastEvent, planId]);

  // Freeze UI when plan is approved via SSE
  const effectiveStatus = stream.status ?? plan?.status ?? null;
  const isApproved = effectiveStatus === "approved";
  const isRejected = effectiveStatus === "rejected";

  // auto-switch to review when approved
  useEffect(() => {
    if (isApproved) setMode("review");
  }, [isApproved]);

  const selectedCohort = plan?.cohorts.find((c) => c.cohort_index === selectedCohortIndex) ?? null;

  const selectedAnchor: string | null =
    selectedCohortIndex !== null
      ? `cohorts[${selectedCohortIndex}]`
      : selectedEdge
        ? `edge:${selectedEdge.from}->${selectedEdge.to}`
        : null;

  // --- structural ops ---

  async function postEdits(edits: Array<{ anchor: string; prev_value: string | null; new_value: string }>) {
    for (const edit of edits) {
      await fetch(`/safir/atoms/plan/${encodeURIComponent(planId)}/edits`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...edit, edited_by: "operator" }),
      });
    }
  }

  async function handleDeleteCohort(cohortIndex: number) {
    const hasEdges = dependencies.some(
      (d) => d.from_cohort_index === cohortIndex || d.to_cohort_index === cohortIndex,
    );
    if (hasEdges) {
      setError(`Remove edges referencing cohort #${cohortIndex} first`);
      return;
    }
    if (!confirm(`Delete cohort #${cohortIndex}?`)) return;
    await postEdits([{ anchor: `cohorts[${cohortIndex}]`, prev_value: null, new_value: "__deleted__" }]);
    setPlan((prev) => prev ? { ...prev, cohorts: prev.cohorts.filter((c) => c.cohort_index !== cohortIndex) } : prev);
    if (selectedCohortIndex === cohortIndex) setSelectedCohortIndex(null);
  }

  async function handleSplit(sourceIndex: number, specs: [ResultCohortSpec, ResultCohortSpec], _migrations: EdgeMigration[]) {
    const nextIdx = Math.max(...(plan?.cohorts.map((c) => c.cohort_index) ?? [0])) + 1;
    const edits = [
      { anchor: `cohorts[${sourceIndex}].title`, prev_value: null, new_value: specs[0].title },
      { anchor: `cohorts[${sourceIndex}].notes`, prev_value: null, new_value: specs[0].notes },
      { anchor: `cohorts[${sourceIndex}].priority`, prev_value: null, new_value: String(specs[0].priority) },
      { anchor: `cohorts[${nextIdx}].title`, prev_value: null, new_value: specs[1].title },
      { anchor: `cohorts[${nextIdx}].notes`, prev_value: null, new_value: specs[1].notes },
      { anchor: `cohorts[${nextIdx}].priority`, prev_value: null, new_value: String(specs[1].priority) },
    ];
    await postEdits(edits);
    const newCohort: CohortAtom = { cohort_index: nextIdx, title: specs[1].title, notes: specs[1].notes, priority: specs[1].priority };
    setPlan((prev) => prev ? { ...prev, cohorts: [...prev.cohorts, newCohort] } : prev);
    setSplitModal(null);
  }

  async function handleMerge(specs: ResultCohortSpec, _migrations: EdgeMigration[]) {
    const nextIdx = Math.max(...(plan?.cohorts.map((c) => c.cohort_index) ?? [0])) + 1;
    const edits = [
      { anchor: `cohorts[${nextIdx}].title`, prev_value: null, new_value: specs.title },
      { anchor: `cohorts[${nextIdx}].notes`, prev_value: null, new_value: specs.notes },
      { anchor: `cohorts[${nextIdx}].priority`, prev_value: null, new_value: String(specs.priority) },
      ...multiSelectIndices.map((i) => ({ anchor: `cohorts[${i}]`, prev_value: null, new_value: "__deleted__" })),
    ];
    await postEdits(edits);
    const newCohort: CohortAtom = { cohort_index: nextIdx, title: specs.title, notes: specs.notes, priority: specs.priority };
    setPlan((prev) => prev ? {
      ...prev,
      cohorts: [...prev.cohorts.filter((c) => !multiSelectIndices.includes(c.cohort_index)), newCohort],
    } : prev);
    setMultiSelectIndices([]);
    setMergeModal(false);
  }

  async function handleAddEdge(from: number, to: number) {
    await postEdits([{ anchor: `deps[${from}->${to}]`, prev_value: null, new_value: "1" }]);
    setPlan((prev) => prev ? { ...prev, dependencies: [...prev.dependencies, { from_cohort_index: from, to_cohort_index: to }] } : prev);
  }

  async function handleDeleteEdge(from: number, to: number) {
    await postEdits([{ anchor: `deps[${from}->${to}]`, prev_value: "1", new_value: "__deleted__" }]);
    setPlan((prev) => prev ? {
      ...prev,
      dependencies: prev.dependencies.filter((d) => !(d.from_cohort_index === from && d.to_cohort_index === to)),
    } : prev);
  }

  // --- thread ops ---

  const handlePostMessage = useCallback(async (threadId: string, body: string) => {
    await fetch(`/safir/threads/${threadId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body, author: "operator" }),
    });
  }, []);

  const handlePing = useCallback(async (threadId: string) => {
    await fetch(`/safir/threads/${threadId}/ping`, { method: "POST" });
  }, []);

  const handleResolve = useCallback(async (threadId: string) => {
    await fetch(`/safir/threads/${threadId}/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "resolved" }),
    });
  }, []);

  async function handleNewThread(anchor: string | null) {
    const initial = prompt("Initial message for new thread:");
    if (!initial) return;
    const res = await fetch("/safir/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_type: "plan", target_id: planId, anchor, initial_message: initial }),
    });
    if (res.ok) {
      const t = (await res.json()) as CommentThread;
      setSelectedThreadId(t.id);
    }
  }

  // --- plan actions ---

  async function handleApprove() {
    setActing(true);
    try {
      const res = await fetch(`/safir/plans/${encodeURIComponent(planId)}/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "approved" }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `approve failed (HTTP ${res.status})`);
      }
    } catch (e) { setError(String(e)); } finally {
      setActing(false);
      setApproveModal(false);
    }
  }

  async function handleReject(reason: string) {
    setActing(true);
    try {
      const res = await fetch(`/safir/plans/${encodeURIComponent(planId)}/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "rejected", rejection_reason: reason }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `reject failed (HTTP ${res.status})`);
      }
    } catch (e) { setError(String(e)); } finally {
      setActing(false);
      setRejectModal(false);
    }
  }

  async function handleReopen() {
    if (!confirm("Reopen this plan? This allows further edits.")) return;
    setActing(true);
    try {
      await fetch(`/safir/plans/${encodeURIComponent(planId)}/reopen`, { method: "POST" });
    } catch (e) { setError(String(e)); } finally { setActing(false); }
  }

  if (loading) return <div className="plan-review-view plan-review-loading">loading…</div>;
  if (!plan) return (
    <div className="plan-review-view">
      <button type="button" onClick={onBack}>← back</button>
      <div className="plan-review-error">{error ?? "plan not found"}</div>
    </div>
  );

  const selectedThread = stream.threads.find((t) => t.id === selectedThreadId) ?? null;
  const incidentEdges = splitModal !== null
    ? dependencies.filter((d) => d.from_cohort_index === splitModal || d.to_cohort_index === splitModal)
    : [];
  const mergeIncidentEdges = mergeModal
    ? dependencies.filter((d) => multiSelectIndices.includes(d.from_cohort_index) || multiSelectIndices.includes(d.to_cohort_index))
    : [];

  return (
    <div className={`plan-review-view${isApproved ? " plan-review-view--approved" : ""}`}>
      {/* header */}
      <header className="plan-review-header">
        <button type="button" className="plan-review-back" onClick={onBack}>← back</button>
        <span className="plan-review-title">plan #{planId.slice(0, 8)}</span>
        {plan.summary && <span className="plan-review-summary">{plan.summary}</span>}
        <span className={`plan-review-status plan-review-status--${effectiveStatus ?? "unknown"}`}>
          {effectiveStatus ?? "unknown"}
        </span>

        {!isApproved && !isRejected && (
          <div className="plan-review-mode-toggle">
            <button
              type="button"
              className={`plan-mode-btn${mode === "direct-edit" ? " plan-mode-btn--active" : ""}`}
              onClick={() => setMode("direct-edit")}
            >
              direct edit
            </button>
            <button
              type="button"
              className={`plan-mode-btn${mode === "review" ? " plan-mode-btn--active" : ""}`}
              onClick={() => setMode("review")}
            >
              review
            </button>
            {mode === "direct-edit" && (
              <button
                type="button"
                className="plan-mode-btn"
                onClick={() => setMultiSelectIndices([])}
              >
                multi-select {multiSelectIndices.length > 0 ? `(${multiSelectIndices.length})` : ""}
              </button>
            )}
          </div>
        )}

        <div className="plan-review-actions">
          {!isApproved && !isRejected && (
            <>
              <button type="button" className="plan-action plan-action--approve" onClick={() => setApproveModal(true)}>approve</button>
              <button type="button" className="plan-action plan-action--reject" onClick={() => setRejectModal(true)}>reject</button>
            </>
          )}
          {isApproved && (
            <button type="button" className="plan-action plan-action--reopen" onClick={() => void handleReopen()}>reopen</button>
          )}
        </div>
      </header>

      {error && <div className="plan-review-error">{error}</div>}

      {/* main layout */}
      <div className="plan-review-body">
        {/* DAG */}
        <div className="plan-review-dag">
          <DagEditor
            cohorts={cohorts}
            dependencies={dependencies}
            threadCounts={threadCounts}
            selectedCohortIndex={selectedCohortIndex}
            onSelectCohort={(idx) => {
              if (multiSelectIndices.length > 0 || mode === "direct-edit") {
                setSelectedCohortIndex(idx);
              } else {
                setSelectedCohortIndex(idx);
                setSelectedEdge(null);
              }
            }}
            onSelectEdge={(from, to) => {
              setSelectedEdge({ from, to });
              setSelectedCohortIndex(null);
              if (mode === "review") {
                const anchor = `edge:${from}->${to}`;
                void handleNewThread(anchor);
              }
            }}
            onConnect={mode === "direct-edit" ? handleAddEdge : undefined}
            onNodeContextMenu={mode === "direct-edit" ? (e, idx) => {
              setContextMenu({ type: "cohort", x: e.clientX, y: e.clientY, cohortIndex: idx });
            } : undefined}
            onEdgeContextMenu={mode === "direct-edit" ? (e, from, to) => {
              setContextMenu({ type: "edge", x: e.clientX, y: e.clientY, edgeFrom: from, edgeTo: to });
            } : undefined}
          />
        </div>

        {/* right column */}
        <div className="plan-review-right">
          {selectedCohort && (
            <CohortPanel
              planId={planId}
              cohort={selectedCohort}
              threads={stream.threads}
              atomHistory={atomHistory}
              mode={isApproved ? "review" : mode}
              directEdit={directEdit}
              atomMap={stream.atomMap}
              onOpenThread={setSelectedThreadId}
              onNewThread={handleNewThread}
              onClose={() => setSelectedCohortIndex(null)}
            />
          )}

          {mode === "review" && selectedThread && (
            <ThreadView
              thread={selectedThread}
              onPostMessage={handlePostMessage}
              onPing={handlePing}
              onResolve={handleResolve}
            />
          )}

          <ThreadSidebar
            threads={stream.threads}
            selectedThreadId={selectedThreadId}
            onSelect={setSelectedThreadId}
            onNewThread={handleNewThread}
            collapsed={sidebarCollapsed}
            onToggleCollapse={() => setSidebarCollapsed((v) => !v)}
          />

          <RevisionHistoryPanel
            target={{ type: "plan", id: planId }}
            anchor={selectedAnchor}
            edits={atomHistory}
            onSelectThread={setSelectedThreadId}
            collapsed={historyCollapsed}
            onToggleCollapse={() => setHistoryCollapsed((v) => !v)}
          />
        </div>
      </div>

      {/* context menus */}
      {contextMenu?.type === "cohort" && contextMenu.cohortIndex !== undefined && (
        <CohortContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          cohortIndex={contextMenu.cohortIndex}
          onSplit={(idx) => setSplitModal(idx)}
          onDelete={(idx) => void handleDeleteCohort(idx)}
          onMergeStart={(idx) => {
            setMultiSelectIndices((prev) => prev.includes(idx) ? prev : [...prev, idx]);
            setMergeModal(true);
          }}
          onClose={() => setContextMenu(null)}
        />
      )}
      {contextMenu?.type === "edge" && contextMenu.edgeFrom !== undefined && contextMenu.edgeTo !== undefined && (
        <EdgeContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          from={contextMenu.edgeFrom}
          to={contextMenu.edgeTo}
          onDelete={(from, to) => void handleDeleteEdge(from, to)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* modals */}
      {splitModal !== null && (
        <SplitCohortModal
          sourceIndex={splitModal}
          incidentEdges={incidentEdges}
          nextIndex={Math.max(...(plan.cohorts.map((c) => c.cohort_index))) + 1}
          onConfirm={(specs, migrations) => void handleSplit(splitModal, specs, migrations)}
          onClose={() => setSplitModal(null)}
        />
      )}
      {mergeModal && (
        <MergeCohortModal
          selectedIndices={multiSelectIndices}
          incidentEdges={mergeIncidentEdges}
          nextIndex={Math.max(...(plan.cohorts.map((c) => c.cohort_index))) + 1}
          onConfirm={(spec, migrations) => void handleMerge(spec, migrations)}
          onClose={() => setMergeModal(false)}
        />
      )}
      {approveModal && (
        <ApproveModal
          threads={stream.threads}
          onConfirm={() => void handleApprove()}
          onClose={() => setApproveModal(false)}
          acting={acting}
        />
      )}
      {rejectModal && (
        <RejectModal
          onConfirm={(reason) => void handleReject(reason)}
          onClose={() => setRejectModal(false)}
          acting={acting}
        />
      )}
    </div>
  );
}
