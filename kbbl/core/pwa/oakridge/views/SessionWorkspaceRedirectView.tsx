import { useEffect } from "react";
import type { Sid } from "../../lib/ids";
import { formatRunWorkspaceHash, replaceHashRoute } from "../../lib/hash";
import { useSessionRun } from "../hooks/useSessionRun";
import { Button } from "../../components/atoms/Button";

interface Props { readonly sessionId: Sid; readonly onBack: () => void }
export function SessionWorkspaceRedirectView({ sessionId, onBack }: Props) {
  const query = useSessionRun(sessionId);
  const runId = query.data?.run_id ?? null;
  useEffect(() => { if (runId) replaceHashRoute(formatRunWorkspaceHash(runId, { kind: "session", session_id: sessionId })); }, [runId, sessionId]);
  return <main className="or-page" data-testid="or-session-redirect">
    {query.isPending && <p role="status">Locating session…</p>}
    {query.isError && <p role="alert">Could not locate session: {String(query.error)}</p>}
    {query.isSuccess && runId === null && <p role="status">This session is absent from the available run projections. <a href={`#sid=${encodeURIComponent(sessionId)}`}>Open it in kbbl</a>.</p>}
    {runId && <p role="status">Opening the run workspace…</p>}
    <Button variant="secondary" onClick={onBack}>Back to runs</Button>
  </main>;
}
