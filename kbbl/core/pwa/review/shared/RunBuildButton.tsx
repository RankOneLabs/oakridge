import { useState, useEffect } from "react";

import type { SessionStatus } from "../../types";

interface RunBuildButtonProps {
  briefId: string;
  cohortId: string;
}

export function RunBuildButton({ briefId, cohortId }: RunBuildButtonProps) {
  const [pending, setPending] = useState(false);
  const [sessionRef, setSessionRef] = useState<string | null>(null);
  // "checking": looking up the cohort's current_session_ref so we don't
  // race the auto-dispatch that brief.approved triggers in dispatch-hooks.
  // The ref is treated as a live build only when:
  //   1. current_session_stage === "build" (skip stale planner refs), AND
  //   2. current_session_status is set and != "ended" (skip refs left
  //      behind by completed/failed sessions — the dispatcher doesn't
  //      clear them on session end). Server-side mirror in handlers/builds.ts.
  // The residual ~ms race between approve-emit and the dispatcher's UPDATE
  // is acknowledged in docs/known_issues.md — worst case is one extra failed
  // POST, caught by the route guard.
  const [checking, setChecking] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setChecking(true);
    // Reset prior cohort's session ref before the new lookup — without this,
    // a stale "Build running" sticks across cohort navigation and hides the
    // recovery button.
    setSessionRef(null);
    fetch(`/cohorts/${encodeURIComponent(cohortId)}`)
      .then((r) =>
        r.ok
          ? (r.json() as Promise<{
              current_session_ref: string | null;
              current_session_stage: string | null;
              current_session_status: SessionStatus | null;
            }>)
          : null,
      )
      .then((cohort) => {
        if (cancelled) return;
        if (
          cohort?.current_session_ref &&
          cohort.current_session_stage === "build" &&
          cohort.current_session_status &&
          cohort.current_session_status !== "ended"
        ) {
          setSessionRef(cohort.current_session_ref);
        }
      })
      .catch(() => {
        // Non-fatal — fall through to manual button; the route guard still
        // defends against most double-dispatch.
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => { cancelled = true; };
  }, [cohortId]);

  const handleRun = async () => {
    setPending(true);
    setErr(null);
    try {
      const res = await fetch(`/briefs/${encodeURIComponent(briefId)}/build`, { method: "POST" });
      if (res.ok) {
        const data = (await res.json()) as { session_ref: string };
        setSessionRef(data.session_ref);
      } else {
        const body = (await res.json()) as { error?: string };
        setErr(body.error ?? `${res.status}`);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "request failed");
    } finally {
      setPending(false);
    }
  };

  if (sessionRef) {
    return (
      <span className="run-build-button__status">
        Build running — session {sessionRef.slice(0, 8)}
      </span>
    );
  }

  if (checking) {
    return (
      <span className="run-build-button__status run-build-button__pending">
        Checking build status…
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        disabled={pending}
        onClick={() => { void handleRun(); }}
        className="run-build-button"
      >
        {pending ? "…" : "Run build"}
      </button>
      {err && (
        <span className="run-build-button__error">{err}</span>
      )}
    </>
  );
}
