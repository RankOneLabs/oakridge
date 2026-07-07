import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useToast } from "../../hooks/useToast";
import { ensureOk } from "../../lib/http";
import type { ReviewThread } from "./types";
import type { MergeBody, MergeOutcome } from "../../../shared/cohort-merge-contract";
import { UnresolvedThreadsModal } from "./UnresolvedThreadsModal";
import { ClosedWithoutMergeModal } from "./ClosedWithoutMergeModal";
import { ThreadsUnknownModal } from "./ThreadsUnknownModal";

interface MergeCohortButtonProps {
  cohortId: string;
  prUrl: string;
}

export function MergeCohortButton({ cohortId, prUrl }: MergeCohortButtonProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [unresolvedThreads, setUnresolvedThreads] = useState<ReviewThread[] | null>(null);
  const [showClosedModal, setShowClosedModal] = useState(false);
  const [showThreadsUnknownModal, setShowThreadsUnknownModal] = useState(false);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["cohorts", { id: cohortId }] });
    void queryClient.invalidateQueries({ queryKey: ["briefs", { cohortId }] });
  };

  const handleOutcome = (data: MergeOutcome) => {
    if (data.outcome === "already_done") {
      pushToast({ kind: "success", message: "Already merged — cohort updated." });
      invalidate();
    } else if (data.outcome === "merged") {
      const message =
        data.via === "already_merged"
          ? data.merged_at
            ? `Already merged at ${data.merged_at} — cohort updated.`
            : "Already merged — cohort updated."
          : "Merged.";
      pushToast({ kind: "success", message });
      invalidate();
    } else if (data.outcome === "confirm_unresolved") {
      setUnresolvedThreads(data.threads);
    } else if (data.outcome === "confirm_threads_unknown") {
      setShowThreadsUnknownModal(true);
    } else if (data.outcome === "confirm_closed") {
      setShowClosedModal(true);
    } else if (data.outcome === "not_mergeable") {
      pushToast({ kind: "error", message: data.reason });
    }
  };

  const mergeMutation = useMutation({
    mutationFn: async (body: MergeBody | undefined): Promise<MergeOutcome> => {
      const res = await fetch(`/cohorts/${encodeURIComponent(cohortId)}/merge`, {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      await ensureOk(res, "merge");
      return (await res.json()) as MergeOutcome;
    },
    onSuccess: handleOutcome,
    onError: (e) => {
      pushToast({
        kind: "error",
        message: e instanceof Error ? e.message : "request failed",
      });
    },
  });

  const handleMerge = () => mergeMutation.mutate(undefined);

  const handleConfirmUnresolved = () => {
    setUnresolvedThreads(null);
    mergeMutation.mutate({ confirm_unresolved: true });
  };

  const handleConfirmClosed = () => {
    setShowClosedModal(false);
    mergeMutation.mutate({ confirm_closed: true });
  };

  const handleConfirmThreadsUnknown = () => {
    setShowThreadsUnknownModal(false);
    mergeMutation.mutate({ confirm_threads_unknown: true });
  };

  return (
    <>
      <button
        type="button"
        className="merge-cohort-button review-shell__tap-target"
        disabled={mergeMutation.isPending}
        onClick={handleMerge}
      >
        {mergeMutation.isPending ? "…" : "Merge"}
      </button>

      {unresolvedThreads && (
        <UnresolvedThreadsModal
          threads={unresolvedThreads}
          prUrl={prUrl}
          pending={mergeMutation.isPending}
          onConfirm={handleConfirmUnresolved}
          onCancel={() => setUnresolvedThreads(null)}
        />
      )}

      {showClosedModal && (
        <ClosedWithoutMergeModal
          pending={mergeMutation.isPending}
          onConfirm={handleConfirmClosed}
          onCancel={() => setShowClosedModal(false)}
        />
      )}

      {showThreadsUnknownModal && (
        <ThreadsUnknownModal
          pending={mergeMutation.isPending}
          onConfirm={handleConfirmThreadsUnknown}
          onCancel={() => setShowThreadsUnknownModal(false)}
        />
      )}
    </>
  );
}
