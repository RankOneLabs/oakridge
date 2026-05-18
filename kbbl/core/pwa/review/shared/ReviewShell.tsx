import { useState, useCallback } from "react";
import { ModeToggle } from "./ModeToggle";
import { ApproveModal } from "../plan/ApproveModal";
import { RejectModal } from "../plan/RejectModal";
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
  approveSubjectLabel: _approveSubjectLabel,
  rejectSubjectLabel: _rejectSubjectLabel,
  artifactId,
  backHref: _backHref,
  threads: _threads,
  selectedThreadId: _selectedThreadId,
  threadMessages: _threadMessages,
  onSelectThread: _onSelectThread,
  onCloseThread: _onCloseThread,
  onNewThread: _onNewThread,
  onSendMessage: _onSendMessage,
  onPing: _onPing,
  onResolve: _onResolve,
  children,
}: ReviewShellProps) {
  const [showApprove, setShowApprove] = useState(false);
  const [showReject, setShowReject] = useState(false);

  const handleApprove = useCallback(async () => {
    await onApprove();
    setShowApprove(false);
  }, [onApprove]);

  const handleReject = useCallback(async (reason: string) => {
    await onReject(reason);
    setShowReject(false);
  }, [onReject]);

  return (
    <div className="review-shell">
      <header className="review-shell__header">
        <button type="button" className="review-shell__button" onClick={onBack}>
          Back
        </button>
        <span className="review-shell__title">
          {artifactTypeLabel} — {statusLabel}
        </span>
        <span className="review-shell__spacer" />
        <button
          type="button"
          className="review-shell__button"
          onClick={onToggleTheme}
        >
          Theme
        </button>
        <ModeToggle mode={mode} onChange={onModeChange} disabled={frozen} />
        {isPendingApproval && (
          <div className="review-shell__actions">
            <button
              type="button"
              className="btn-approve"
              onClick={() => setShowApprove(true)}
              disabled={actionPending}
            >
              Approve
            </button>
            <button
              type="button"
              className="btn-deny"
              onClick={() => setShowReject(true)}
              disabled={actionPending}
            >
              Reject
            </button>
          </div>
        )}
      </header>
      <div className="review-shell__main">
        <div className="review-shell__canvas-slot">{children}</div>
      </div>
      <div className="review-shell__modal-layer">
        {showApprove && (
          <ApproveModal
            planId={artifactId}
            onConfirm={handleApprove}
            onCancel={() => setShowApprove(false)}
            pending={actionPending}
          />
        )}
        {showReject && (
          <RejectModal
            planId={artifactId}
            onConfirm={handleReject}
            onCancel={() => setShowReject(false)}
            pending={actionPending}
          />
        )}
      </div>
    </div>
  );
}
