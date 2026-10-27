import { useMutation } from "@tanstack/react-query";

import type { SessionSnapshot } from "../types";
import type { Sid } from "../lib/ids";
import {
  selectBulkHideEligibleSessions,
  summarizeBulkHideOutcome,
  type BulkHideAttempt,
} from "../lib/session-bulk-hide";
import { sessionCloseError } from "../lib/session-close";
import { useStore } from "../state/store";

const BULK_HIDE_CONCURRENCY = 3;

function markSessionArchived(sid: Sid): void {
  useStore.setState((state) => {
    const session = state.sessions.get(sid);
    if (!session) return state;
    const sessions = new Map(state.sessions);
    // Eligibility guarantees terminal status. Keep it, just as useEndSession does.
    const status = session.status === "ended" || session.status === "fenced" || session.status === "failed"
      ? session.status
      : "ended";
    sessions.set(sid, { ...session, status, archivedAt: new Date().toISOString() });
    return { sessions };
  });
}

async function archiveSession(sid: Sid): Promise<BulkHideAttempt> {
  try {
    const response = await fetch(`/sessions/${encodeURIComponent(sid)}?archive=true`, {
      method: "DELETE",
    });
    if (!response.ok) {
      const error = await sessionCloseError(response);
      return { kind: "refused", sid, refusal: error.refusal };
    }
    markSessionArchived(sid);
    return { kind: "archived", sid };
  } catch (error) {
    return {
      kind: "refused",
      sid,
      refusal: { kind: "rejected", message: error instanceof Error ? error.message : "network error" },
    };
  }
}

/** Archive the frozen eligible set with a fixed maximum of concurrent requests. */
export function useHideEndedSessions() {
  return useMutation({
    mutationFn: async (snapshots: readonly SessionSnapshot[]) => {
      const eligibleSids = selectBulkHideEligibleSessions(snapshots);
      const attempts: BulkHideAttempt[] = new Array(eligibleSids.length);
      let nextIndex = 0;
      async function worker(): Promise<void> {
        while (nextIndex < eligibleSids.length) {
          const index = nextIndex++;
          attempts[index] = await archiveSession(eligibleSids[index]);
        }
      }
      await Promise.all(Array.from(
        { length: Math.min(BULK_HIDE_CONCURRENCY, eligibleSids.length) },
        () => worker(),
      ));
      return summarizeBulkHideOutcome(eligibleSids, attempts);
    },
  });
}
