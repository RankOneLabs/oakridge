import { Button } from "../atoms/Button";
import { useMemo, useState } from "react";

import { useStore } from "../../state/store";
import { selectSessionsAwaitingApproval, type ApprovalWaiter } from "../../lib/selectors";
import { selectOpenPermissions, type TimelineItem } from "../../lib/session-items";
import { writeHashPermissionTarget, writeHashSessionTarget } from "../../lib/hash";
import { useAcpSession } from "../../hooks/useAcpSession";
import { usePermissionAnswer } from "../../hooks/usePermissionAnswer";

type OpenPermission = Extract<TimelineItem, { kind: "permission" }>;

function ApprovalRequest({ sid, sessionName, permission }: {
  sid: string;
  sessionName: string;
  permission: OpenPermission;
}) {
  const answer = usePermissionAnswer(sid);
  const [error, setError] = useState<string | null>(null);

  const choose = async (optionId: string) => {
    if (answer.isPending) return;
    setError(null);
    try {
      await answer.mutateAsync({ requestId: permission.requestId, optionId });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "network error");
    }
  };

  return (
    <section className="pending-approval-toast" aria-label={`Approval in ${sessionName}`}>
      <div className="pending-approval-toast__session">{sessionName}</div>
      <div className="pending-approval-toast__title">{permission.title}</div>
      {error && <div className="card-error" role="alert">error: {error}</div>}
      <div className="pending-approval-toast__actions">
        {permission.options.map((option) => (
          <Button variant="session"
            key={option.optionId}
            type="button"
            className={option.kind?.startsWith("reject") ? "btn-deny" : "btn-approve"}
            disabled={answer.isPending}
            onClick={() => void choose(option.optionId)}
          >
            {option.name}
          </Button>
        ))}
        <Button variant="session" type="button" className="pending-approval-toast__link" onClick={() => writeHashPermissionTarget(sid, permission.requestId)}>
          Open in session
        </Button>
      </div>
    </section>
  );
}

function SessionApprovals({ waiter }: { waiter: ApprovalWaiter }) {
  const { sessionState, historyLoaded } = useAcpSession(waiter.sid);
  const openPermissions = useMemo(() => selectOpenPermissions(sessionState), [sessionState]);

  if (!historyLoaded || openPermissions.length === 0) {
    return (
      <Button variant="session" type="button" className="pending-approval-toast pending-approval-toast--loading"
        onClick={() => writeHashSessionTarget(waiter.sid, "pending-permission")}
      >
        {waiter.pendingCount} approval{waiter.pendingCount === 1 ? "" : "s"} pending · {waiter.name}
      </Button>
    );
  }

  return <>{openPermissions.map((permission) => (
    <ApprovalRequest key={permission.requestId} sid={waiter.sid} sessionName={waiter.name} permission={permission} />
  ))}</>;
}

/** Persistent approval notices for every session with a pending tool request. */
export function PendingApprovalsBadge() {
  const sessions = useStore((s) => s.sessions);
  const waiters = selectSessionsAwaitingApproval([...sessions.values()]);
  if (waiters.length === 0) return null;

  return (
    <div className="pending-approvals" aria-label="Pending approvals" aria-live="polite">
      {waiters.map((waiter) => <SessionApprovals key={waiter.sid} waiter={waiter} />)}
    </div>
  );
}
