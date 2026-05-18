import { useState, useEffect } from "react";
import { ModeToggle } from "./ModeToggle";
import { ThreadSidebar } from "./ThreadSidebar";
import { ThreadView } from "./ThreadView";
import { ApproveModal } from "./ApproveModal";
import { RejectModal } from "./RejectModal";
import { Sheet } from "./Sheet";
import { useViewport } from "./useViewport";
import type { ReviewShellProps } from "./types";
export type { ReviewShellProps, CanvasProps } from "./types";

export function ReviewShell({
  onBack,
  artifactTypeLabel,
  statusLabel,
  frozen,
  actionPending,
  isPendingApproval,
  onToggleTheme,
  mode,
  onModeChange,
  onApprove,
  onReject,
  approveSubjectLabel,
  rejectSubjectLabel,
  artifactId,
  backHref: _backHref,
  threads,
  selectedThreadId,
  threadMessages,
  onSelectThread,
  onCloseThread,
  onNewThread,
  onSendMessage,
  onPing,
  onResolve,
  children,
}: ReviewShellProps) {
  const [showApprove, setShowApprove] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [threadsSheetOpen, setThreadsSheetOpen] = useState(false);

  const { isPhone } = useViewport();

  useEffect(() => {
    if (!isPhone) setThreadsSheetOpen(false);
  }, [isPhone]);

  const handleApprove = async () => {
    await onApprove();
    setShowApprove(false);
  };

  const handleReject = async (reason: string) => {
    await onReject(reason);
    setShowReject(false);
  };

  const selectedThread = threads.find((t) => t.id === selectedThreadId) ?? null;
  const openThreadCount = threads.filter((t) => t.status === "open").length;

  const threadSidebar = (
    <ThreadSidebar
      threads={threads}
      selectedThreadId={selectedThreadId}
      onSelect={(id) => {
        onSelectThread(id);
        if (isPhone) setThreadsSheetOpen(false);
      }}
      onNewThread={() => {
        onNewThread();
        if (isPhone) setThreadsSheetOpen(false);
      }}
    />
  );

  return (
    <div className="review-shell">
      <header className="review-shell__header">
        <button
          type="button"
          className="review-shell__button review-shell__tap-target"
          onClick={onBack}
        >
          Back
        </button>
        <span className="review-shell__title">
          {artifactTypeLabel} — {statusLabel}
        </span>
        <span className="review-shell__spacer" />
        {frozen && (
          <span className="review-shell__frozen-chip">frozen</span>
        )}
        <button
          type="button"
          className="review-shell__threads-chip review-shell__tap-target"
          onClick={() => setThreadsSheetOpen(true)}
          aria-label="Open threads"
        >
          💬{openThreadCount > 0 ? ` ${openThreadCount}` : ""}
        </button>
        <button
          type="button"
          className="review-shell__button review-shell__tap-target"
          onClick={onToggleTheme}
        >
          Theme
        </button>
        <ModeToggle mode={mode} onChange={onModeChange} disabled={frozen} />
        {isPendingApproval && (
          <div className="review-shell__actions">
            <button
              type="button"
              className="btn-approve review-shell__tap-target"
              onClick={() => setShowApprove(true)}
              disabled={actionPending || frozen}
            >
              Approve
            </button>
            <button
              type="button"
              className="btn-deny review-shell__tap-target"
              onClick={() => setShowReject(true)}
              disabled={actionPending || frozen}
            >
              Reject
            </button>
          </div>
        )}
      </header>
      <div className="review-shell__main">
        <div className="review-shell__canvas-slot">{children}</div>
        {selectedThread && (
          <div className="review-shell__thread-detail">
            <div className="review-shell__thread-detail-header">
              <button
                type="button"
                className="review-shell__tap-target"
                style={{ fontSize: 12 }}
                onClick={onCloseThread}
              >
                Close
              </button>
            </div>
            <ThreadView
              thread={selectedThread}
              messages={threadMessages.get(selectedThread.id) ?? []}
              onSendMessage={(body) => onSendMessage(selectedThread.id, body)}
              onPing={() => onPing(selectedThread.id)}
              onResolve={() => onResolve(selectedThread.id)}
              frozen={frozen}
            />
          </div>
        )}
        <div className="review-shell__threads">
          {threadSidebar}
        </div>
      </div>

      {/* Phone: threads in a right Sheet */}
      {isPhone && (
        <Sheet
          open={threadsSheetOpen}
          side="right"
          onClose={() => setThreadsSheetOpen(false)}
          ariaLabel="Threads"
        >
          {threadSidebar}
        </Sheet>
      )}

      <div className="review-shell__modal-layer">
        {showApprove && (
          <ApproveModal
            artifactId={artifactId}
            subjectLabel={approveSubjectLabel}
            onConfirm={handleApprove}
            onCancel={() => setShowApprove(false)}
            pending={actionPending}
          />
        )}
        {showReject && (
          <RejectModal
            artifactId={artifactId}
            subjectLabel={rejectSubjectLabel}
            onConfirm={handleReject}
            onCancel={() => setShowReject(false)}
            pending={actionPending}
          />
        )}
      </div>
    </div>
  );
}
