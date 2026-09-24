import { useEffect } from "react";

import { useSessionRun } from "../hooks/useSessionRun";
import { formatRunWorkspaceHash, replaceHashRoute } from "../../lib/hash";
import type { Sid } from "../../lib/ids";

interface SessionWorkspaceRedirectViewProps {
  sessionId: Sid;
  onBack: () => void;
}

/**
 * `#oakridge/session/:sid` resolved to the run that owns the session and
 * replaced with the canonical in-workspace form.
 *
 * `GET /sessions/:id/run` answers unconditionally — it is navigation, not a
 * close-safety hold — so a session whose work finished and whose cleanup
 * completed still lands in its run. A session that belongs to no run has
 * nowhere to land, which is a not-found state rather than a redirect.
 */
export function SessionWorkspaceRedirectView({ sessionId, onBack }: SessionWorkspaceRedirectViewProps) {
  const query = useSessionRun(sessionId);
  const runId = query.data?.run_id ?? null;

  useEffect(() => {
    if (runId === null) return;
    replaceHashRoute(formatRunWorkspaceHash(runId, { kind: "session", session_id: sessionId }));
  }, [runId, sessionId]);

  if (query.isPending) {
    return (
      <div className="or-page" data-testid="or-session-redirect">
        <div className="py-6 text-sm text-[var(--text-muted)]">Locating session…</div>
      </div>
    );
  }

  if (runId !== null) {
    return (
      <div className="or-page" data-testid="or-session-redirect">
        <div className="py-6 text-sm text-[var(--text-muted)]">Opening the run workspace…</div>
      </div>
    );
  }

  return (
    <div className="or-page" data-testid="or-session-redirect">
      <div
        className="rounded-md border border-[var(--border-muted)] px-4 py-3 text-sm text-[var(--text-secondary)]"
        role="status"
        data-testid="or-session-not-in-run"
      >
        <p className="m-0">This session does not belong to any workflow run.</p>
        <p className="mb-0 mt-2">
          <a className="text-[var(--accent-blue)] underline" href={`#sid=${encodeURIComponent(sessionId)}`}>
            Open it in kbbl
          </a>
        </p>
      </div>
      <div>
        <button type="button" className="or-shell__back" onClick={onBack}>
          Back to runs
        </button>
      </div>
    </div>
  );
}
