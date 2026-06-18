import { useStore } from "../../state/store";
import { selectSessionsAwaitingApproval } from "../../lib/selectors";
import { writeHashSid } from "../../lib/hash";

/**
 * Global, always-visible badge for parked tool-approvals. Rendered in the app
 * shell (sibling of ToastViewport) so an approval waiting in ANY session is
 * visible from every view — not only inside that session's own conversation,
 * where it would otherwise sit unseen until CC's permission hook times out.
 * Clicking routes to a session that's waiting. Renders nothing when there is
 * nothing to approve.
 */
export function PendingApprovalsBadge() {
  const sessions = useStore((s) => s.sessions);
  const waiters = selectSessionsAwaitingApproval([...sessions.values()]);
  if (waiters.length === 0) return null;

  const total = waiters.reduce((sum, w) => sum + w.pendingCount, 0);
  const target = waiters[0];
  const label =
    waiters.length === 1
      ? `${total} approval${total === 1 ? "" : "s"} pending · ${target.name}`
      : `${total} approvals pending · ${waiters.length} sessions`;

  return (
    <button
      type="button"
      className="pending-approvals-badge"
      onClick={() => {
        writeHashSid(target.sid);
      }}
      title="Open the session waiting for tool approval"
    >
      <span className="pending-approvals-badge-dot" aria-hidden="true" />
      {label}
    </button>
  );
}
