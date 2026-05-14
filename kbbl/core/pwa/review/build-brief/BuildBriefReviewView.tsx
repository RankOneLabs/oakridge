import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { BuildBriefRenderer } from "./BuildBriefRenderer";
import { AtomEditor } from "./AtomEditor";
import { useListItemDelete } from "./useListItemDelete";
import { DebriefOverlay } from "./DebriefOverlay";
import { RunBuildButton } from "./RunBuildButton";
import { ModeToggle } from "../shared/ModeToggle";
import { ThreadSidebar } from "../shared/ThreadSidebar";
import { ThreadView } from "../shared/ThreadView";
import { RevisionHistoryPanel } from "../shared/RevisionHistoryPanel";
import { useArtifactStream } from "../shared/useArtifactStream";
import { useDirectEdit } from "../shared/useDirectEdit";
import { useBuildLifecycleStream } from "./useBuildLifecycleStream";
import type { AtomEditRecord, CommentThread } from "../shared/types";

interface BuildBriefRun {
  id: string;
  phases: Array<{ phase_index: number }>;
}

interface BuildBrief {
  id: string;
  goal: string | null;
  next_action: string | null;
  active_subgoals: string[] | null;
  decisions_made: Array<{ decision: string; rationale: string }> | null;
  approaches_rejected: Array<{ approach: string; reason: string }> | null;
  files_in_scope: string[] | null;
  open_questions: string[] | null;
  status: string;
  rejection_reason: string | null;
  debrief: {
    delivered_summary: string;
    not_delivered: Array<{ item: string; reason: string; notes?: string }>;
    deviations: Array<{ instruction: string; actual: string; rationale?: string }>;
  } | null;
  run_id: string | null;
}

interface Props {
  briefId: string;
  onBack: () => void;
}

type Mode = "direct-edit" | "review";

export function BuildBriefReviewView({ briefId, onBack }: Props) {
  const [brief, setBrief] = useState<BuildBrief | null>(null);
  const [run, setRun] = useState<BuildBriefRun | null>(null);
  const [atomHistory, setAtomHistory] = useState<AtomEditRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [mode, setMode] = useState<Mode>("direct-edit");
  const [editingAnchor, setEditingAnchor] = useState<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [historyCollapsed, setHistoryCollapsed] = useState(true);
  const [acting, setActing] = useState(false);
  const [approveModal, setApproveModal] = useState(false);
  const [rejectModal, setRejectModal] = useState(false);

  const target = { type: "build_brief" as const, id: briefId };
  const stream = useArtifactStream(target);
  const directEdit = useDirectEdit(target);
  const listItemDelete = useListItemDelete(target);
  useBuildLifecycleStream(briefId, () => {
    // Reload brief on build completion to pick up debrief
    void loadBrief();
  });

  const status = stream.status ?? brief?.status ?? null;

  // Pipe directEdit CAS/server errors into the shared error banner
  useEffect(() => {
    if (directEdit.error) setError(directEdit.error);
  }, [directEdit.error]);

  async function loadBrief() {
    try {
      const [briefRes, histRes, runRes] = await Promise.all([
        fetch(`/safir/build-briefs/${encodeURIComponent(briefId)}`),
        fetch(`/safir/atoms/build_brief/${encodeURIComponent(briefId)}/history`),
        fetch(`/safir/build-briefs/${encodeURIComponent(briefId)}/run`),
      ]);
      if (!briefRes.ok) {
        setError(`failed to load brief (HTTP ${briefRes.status})`);
        return;
      }
      setBrief((await briefRes.json()) as BuildBrief);
      if (histRes.ok) setAtomHistory((await histRes.json()) as AtomEditRecord[]);
      if (runRes.ok) setRun((await runRes.json()) as BuildBriefRun);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      await loadBrief();
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [briefId]);

  const handleSaveAtom = useCallback(
    async (anchor: string, prevValue: string | null, newValue: string) => {
      const ok = await directEdit.save(anchor, prevValue, newValue);
      if (ok) setEditingAnchor(null);
    },
    [directEdit],
  );

  const handleAddListItem = useCallback(
    (field: string) => {
      // Compute the next index using the same max-index logic as BuildBriefRenderer
      const indices = Object.keys(stream.atomMap)
        .filter((k) => k.startsWith(`${field}[`))
        .map((k) => { const m = k.match(/\[(\d+)\]/); return m ? parseInt(m[1], 10) : -1; })
        .filter((n) => n >= 0);
      const n = indices.length > 0 ? Math.max(...indices) + 1 : 0;
      // Compound fields: set editing anchor on the first sub-field so AtomRow matches
      const firstSub =
        field === "decisions_made" ? ".decision"
        : field === "approaches_rejected" ? ".approach"
        : "";
      setEditingAnchor(`${field}[${n}]${firstSub}`);
    },
    [stream.atomMap],
  );

  const handleDeleteListItem = useCallback(
    async (field: string, index: number) => {
      await listItemDelete.deleteItem(field, index, stream.atomMap);
    },
    [listItemDelete, stream.atomMap],
  );

  async function postAction(path: string, body: unknown, method = "POST") {
    setActing(true);
    try {
      const res = await fetch(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `action failed (HTTP ${res.status})`);
        return;
      }
      const updated = (await res.json()) as BuildBrief;
      setBrief(updated);
      setApproveModal(false);
      setRejectModal(false);
    } finally {
      setActing(false);
    }
  }

  async function handleApprove() {
    await postAction(
      `/safir/build-briefs/${encodeURIComponent(briefId)}/status`,
      { status: "approved" },
      "PATCH",
    );
  }

  async function handleReject(reason: string) {
    await postAction(
      `/safir/build-briefs/${encodeURIComponent(briefId)}/status`,
      { status: "rejected", rejection_reason: reason },
      "PATCH",
    );
  }

  async function handleReopen() {
    await postAction(
      `/safir/build-briefs/${encodeURIComponent(briefId)}/reopen`,
      {},
    );
  }

  async function handlePostMessage(threadId: string, body: string) {
    await fetch(`/safir/threads/${encodeURIComponent(threadId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body, author: "operator" }),
    });
  }

  async function handlePingThread(threadId: string) {
    await fetch(`/safir/threads/${encodeURIComponent(threadId)}/ping`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
  }

  async function handleResolveThread(threadId: string) {
    await fetch(`/safir/threads/${encodeURIComponent(threadId)}/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "resolved" }),
    });
  }

  async function handleNewThread(anchor: string | null) {
    const res = await fetch("/safir/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target_type: "build_brief",
        target_id: briefId,
        anchor,
        initial_message: { author: "operator", body: "Operator opened thread" },
      }),
    });
    if (res.ok) {
      const t = (await res.json()) as CommentThread;
      setSelectedThreadId(t.id);
    }
  }

  const selectedThread = stream.threads.find((t) => t.id === selectedThreadId) ?? null;

  const renderAtomEditor = (anchor: string, value: string) => (
    <AtomEditor
      anchor={anchor}
      value={stream.atomMap[anchor] ?? value}
      onSave={(newVal) => void handleSaveAtom(anchor, stream.atomMap[anchor] ?? null, newVal)}
      onCancel={() => setEditingAnchor(null)}
      saving={directEdit.saving}
    />
  );

  if (loading) return <div className="brief-loading">Loading…</div>;
  if (error && !brief) return <div className="brief-error">{error}</div>;
  if (!brief) return null;

  const debrief = brief.debrief ?? null;

  return (
    <div className="brief-review-view">
      <div className="brief-review-header">
        <button type="button" className="brief-back" onClick={onBack}>
          ← back
        </button>
        <div className="brief-review-header-meta">
          <span className={`brief-status brief-status--${status ?? "unknown"}`}>
            {status ?? "unknown"}
          </span>
          {brief.rejection_reason && (
            <span className="brief-rejection-reason">{brief.rejection_reason}</span>
          )}
        </div>
        <div className="brief-review-header-actions">
          <ModeToggle mode={mode} onChange={(m) => { setMode(m); setEditingAnchor(null); }} />
          {status === "pending_approval" && (
            <>
              <button
                type="button"
                className="brief-action-btn brief-action-btn--approve"
                onClick={() => setApproveModal(true)}
                disabled={acting}
              >
                Approve
              </button>
              <button
                type="button"
                className="brief-action-btn brief-action-btn--reject"
                onClick={() => setRejectModal(true)}
                disabled={acting}
              >
                Reject
              </button>
            </>
          )}
          {status === "approved" && (
            <>
              <button
                type="button"
                className="brief-action-btn brief-action-btn--reopen"
                onClick={() => void handleReopen()}
                disabled={acting}
              >
                Reopen
              </button>
              <RunBuildButton
                briefId={briefId}
                run={run}
                status={status}
              />
            </>
          )}
        </div>
      </div>

      {error && <div className="brief-error brief-error--inline">{error}</div>}
      {debrief && <DebriefOverlay debrief={debrief} />}

      <div className="brief-review-body">
        <div className="brief-review-main">
          <BuildBriefRenderer
            atomMap={stream.atomMap}
            threads={stream.threads}
            mode={mode}
            onAtomClick={(anchor) => {
              if (mode === "direct-edit") setEditingAnchor(anchor);
            }}
            onNewThread={handleNewThread}
            onAddListItem={handleAddListItem}
            onDeleteListItem={handleDeleteListItem}
            editingAnchor={editingAnchor}
            renderAtomEditor={renderAtomEditor}
          />
        </div>

        <div className="brief-review-sidebar">
          <ThreadSidebar
            threads={stream.threads}
            selectedThreadId={selectedThreadId}
            onSelect={setSelectedThreadId}
            onNewThread={handleNewThread}
            collapsed={sidebarCollapsed}
            onToggleCollapse={() => setSidebarCollapsed((p) => !p)}
          />
          {selectedThread && (
            <ThreadView
              thread={selectedThread}
              onPostMessage={handlePostMessage}
              onPing={handlePingThread}
              onResolve={handleResolveThread}
            />
          )}
          <RevisionHistoryPanel
            target={target}
            edits={atomHistory}
            onSelectThread={setSelectedThreadId}
            collapsed={historyCollapsed}
            onToggleCollapse={() => setHistoryCollapsed((p) => !p)}
          />
        </div>
      </div>

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

// Inline modals (reuse plan review patterns)

function ApproveModal({
  threads,
  onConfirm,
  onClose,
  acting,
}: {
  threads: CommentThread[];
  onConfirm: () => void;
  onClose: () => void;
  acting: boolean;
}) {
  const openCount = threads.filter((t) => t.status === "open").length;
  return createPortal(
    <div className="modal-overlay" onClick={acting ? undefined : onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2>Approve build brief?</h2>
        {openCount > 0 && (
          <p className="modal-warning">
            {openCount} open thread{openCount !== 1 ? "s" : ""} — approve anyway?
          </p>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={acting}>cancel</button>
          <button
            type="button"
            className="modal-confirm modal-confirm--approve"
            onClick={onConfirm}
            disabled={acting}
          >
            {acting ? "approving…" : "approve"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function RejectModal({
  onConfirm,
  onClose,
  acting,
}: {
  onConfirm: (reason: string) => void;
  onClose: () => void;
  acting: boolean;
}) {
  const [reason, setReason] = useState("");
  return createPortal(
    <div className="modal-overlay" onClick={acting ? undefined : onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2>Reject build brief?</h2>
        <label>
          Rejection reason
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={4}
            placeholder="Explain why this brief is rejected…"
          />
        </label>
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={acting}>cancel</button>
          <button
            type="button"
            className="modal-confirm modal-confirm--reject"
            onClick={() => onConfirm(reason.trim() || "operator rejected")}
            disabled={acting}
          >
            {acting ? "rejecting…" : "reject"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
