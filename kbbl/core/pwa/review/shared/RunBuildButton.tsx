import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { SessionStatus } from "../../types";

type CohortStatus =
  | "waiting"
  | "planned"
  | "briefing"
  | "brief_review"
  | "building"
  | "ready_to_build"
  | "awaiting_merge"
  | "done"
  | "blocked";

interface RunBuildButtonProps {
  briefId: string;
  cohortId: string;
}

interface CohortStatusResponse {
  status: CohortStatus;
  current_session_ref: string | null;
  current_session_stage: string | null;
  current_session_status: SessionStatus | null;
}

export function RunBuildButton({ briefId, cohortId }: RunBuildButtonProps) {
  const queryClient = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  // Optimistic — set when the build POST returns successfully, before the
  // next cohort query refresh would otherwise flip the UI to "Build running".
  const [optimisticSessionRef, setOptimisticSessionRef] = useState<string | null>(
    null,
  );

  useEffect(() => {
    setErr(null);
    setOptimisticSessionRef(null);
  }, [briefId, cohortId]);

  const checkQuery = useQuery({
    queryKey: ["cohorts", { id: cohortId }],
    queryFn: async (): Promise<CohortStatusResponse | null> => {
      const res = await fetch(`/cohorts/${encodeURIComponent(cohortId)}`);
      if (!res.ok) return null;
      return (await res.json()) as CohortStatusResponse;
    },
    retry: false,
  });

  const buildMutation = useMutation({
    mutationFn: async (): Promise<{ session_ref: string }> => {
      const res = await fetch(
        `/briefs/${encodeURIComponent(briefId)}/build`,
        { method: "POST" },
      );
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `${res.status}`);
      }
      return (await res.json()) as { session_ref: string };
    },
    onSuccess: (data) => {
      setOptimisticSessionRef(data.session_ref);
      void queryClient.invalidateQueries({
        queryKey: ["cohorts", { id: cohortId }],
      });
    },
    onError: (e) => {
      setOptimisticSessionRef(null);
      setErr(e instanceof Error ? e.message : "request failed");
    },
  });

  // A cohort's ref counts as a LIVE build only when:
  //   1. current_session_stage === "build" (skip stale planner refs), AND
  //   2. current_session_status is set and != "ended" (skip refs left behind
  //      by completed/failed sessions — the dispatcher doesn't clear them
  //      on session end).
  // Server-side mirror in handlers/builds.ts. The residual ~ms race between
  // approve-emit and dispatcher UPDATE is acknowledged in
  // docs/known_issues.md — worst case is one extra failed POST, caught by
  // the route guard.
  const cohort = checkQuery.data;
  const liveRefFromCheck =
    cohort?.current_session_ref &&
    cohort.current_session_stage === "build" &&
    cohort.current_session_status &&
    cohort.current_session_status !== "ended"
      ? cohort.current_session_ref
      : null;
  const sessionRef = optimisticSessionRef ?? liveRefFromCheck;

  useEffect(() => {
    if (!optimisticSessionRef || checkQuery.isPending || !checkQuery.data) return;
    if (liveRefFromCheck === optimisticSessionRef || liveRefFromCheck === null) {
      setOptimisticSessionRef(null);
    }
  }, [checkQuery.data, checkQuery.isPending, liveRefFromCheck, optimisticSessionRef]);

  const handleRun = () => {
    setErr(null);
    buildMutation.mutate();
  };

  if (sessionRef) {
    return (
      <span className="run-build-button__status">
        Build running — session {sessionRef.slice(0, 8)}
      </span>
    );
  }

  if (checkQuery.isPending) {
    return (
      <span className="run-build-button__status run-build-button__pending">
        Checking build status…
      </span>
    );
  }

  // Deps not yet built — the orchestrator auto-dispatches the build once the
  // last dependency resolves, so offering a manual run here would only 409.
  if (cohort?.status === "ready_to_build") {
    return (
      <span className="run-build-button__status run-build-button__pending">
        Waiting on dependencies
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        disabled={buildMutation.isPending}
        onClick={handleRun}
        className="run-build-button"
      >
        {buildMutation.isPending ? "…" : "Run build"}
      </button>
      {err && (
        <span className="run-build-button__error">{err}</span>
      )}
    </>
  );
}
